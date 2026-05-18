#include <algorithm>
#include <cassert>
#include <compare>
#include <cstdint>
#include <iostream>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace crdt {

struct OpId {
  std::uint64_t counter{};
  std::string replica;

  friend auto operator<=>(const OpId &, const OpId &) = default;
};

std::ostream &operator<<(std::ostream &out, const OpId &id) {
  return out << id.counter << "@" << id.replica;
}

struct LamportClock {
  explicit LamportClock(std::string replica_id)
      : replica(std::move(replica_id)) {}

  OpId tick() { return OpId{++counter, replica}; }

  void observe(const OpId &remote) { counter = std::max(counter, remote.counter); }

  std::string replica;
  std::uint64_t counter{};
};

template <typename T> class LwwRegister {
public:
  void assign(T value, OpId time) {
    if (!state || state->time < time) {
      state = Entry{std::move(value), std::move(time)};
    }
  }

  void merge(const LwwRegister<T> &other) {
    if (other.state) {
      assign(other.state->value, other.state->time);
    }
  }

  const T &value() const {
    if (!state) {
      throw std::logic_error("LWW register has no value");
    }
    return state->value;
  }

  bool has_value() const { return state.has_value(); }

private:
  struct Entry {
    T value;
    OpId time;
  };

  std::optional<Entry> state;
};

template <typename T> class AwSet {
public:
  OpId add(const T &value, OpId dot) {
    additions[value].insert(dot);
    return dot;
  }

  void remove(const T &value) {
    auto found = additions.find(value);
    if (found == additions.end()) {
      return;
    }

    for (const auto &dot : found->second) {
      removals[value].insert(dot);
    }
  }

  void merge(const AwSet<T> &other) {
    for (const auto &[value, dots] : other.additions) {
      additions[value].insert(dots.begin(), dots.end());
    }

    for (const auto &[value, dots] : other.removals) {
      removals[value].insert(dots.begin(), dots.end());
    }
  }

  bool contains(const T &value) const {
    auto added = additions.find(value);
    if (added == additions.end()) {
      return false;
    }

    auto removed = removals.find(value);
    for (const auto &dot : added->second) {
      if (removed == removals.end() || !removed->second.contains(dot)) {
        return true;
      }
    }
    return false;
  }

  std::vector<T> values() const {
    std::vector<T> result;
    for (const auto &[value, _] : additions) {
      if (contains(value)) {
        result.push_back(value);
      }
    }
    return result;
  }

private:
  std::map<T, std::set<OpId>> additions;
  std::map<T, std::set<OpId>> removals;
};

class RgaText {
public:
  struct Element {
    OpId id;
    std::optional<OpId> previous;
    char value{};
    bool removed{};
  };

  OpId insert_after(std::optional<OpId> previous, char value, OpId id) {
    elements[id] = Element{id, std::move(previous), value, false};
    return id;
  }

  std::optional<OpId> insert_at(std::size_t index, char value, OpId id) {
    auto previous = predecessor_for_insert(index);
    insert_after(previous, value, id);
    return id;
  }

  std::vector<OpId> erase_range(std::size_t index, std::size_t count) {
    std::vector<OpId> erased;
    auto order = visible_order();
    if (index >= order.size()) {
      return erased;
    }

    const std::size_t end = std::min(order.size(), index + count);
    for (std::size_t i = index; i < end; ++i) {
      erased.push_back(order[i]->id);
      erase(order[i]->id);
    }
    return erased;
  }

  void erase(const OpId &id) {
    auto found = elements.find(id);
    if (found != elements.end()) {
      found->second.removed = true;
    } else {
      pending_deletes.insert(id);
    }
  }

  void merge(const RgaText &other) {
    for (const auto &[id, element] : other.elements) {
      auto [it, inserted] = elements.emplace(id, element);
      if (!inserted) {
        it->second.removed = it->second.removed || element.removed;
      }
    }

    pending_deletes.insert(other.pending_deletes.begin(),
                           other.pending_deletes.end());
    for (const auto &id : pending_deletes) {
      auto found = elements.find(id);
      if (found != elements.end()) {
        found->second.removed = true;
      }
    }
  }

  std::string str() const {
    std::map<std::optional<OpId>, std::vector<const Element *>> children;
    for (const auto &[_, element] : elements) {
      children[element.previous].push_back(&element);
    }

    for (auto &[_, siblings] : children) {
      std::ranges::sort(siblings, [](const Element *left, const Element *right) {
        return right->id < left->id;
      });
    }

    std::string result;
    append_visible(std::nullopt, children, result);
    return result;
  }

  std::string columnar_encoding() const {
    std::ostringstream out;
    out << "op_id,ref_id,char,removed\n";
    for (const auto &[id, element] : elements) {
      out << id << ",";
      if (element.previous) {
        out << *element.previous;
      } else {
        out << "ROOT";
      }
      out << "," << element.value << "," << (element.removed ? "true" : "false")
          << "\n";
    }
    return out.str();
  }

private:
  std::vector<const Element *> visible_order() const {
    std::map<std::optional<OpId>, std::vector<const Element *>> children;
    for (const auto &[_, element] : elements) {
      children[element.previous].push_back(&element);
    }

    for (auto &[_, siblings] : children) {
      std::ranges::sort(siblings, [](const Element *left, const Element *right) {
        return right->id < left->id;
      });
    }

    std::vector<const Element *> result;
    append_visible_elements(std::nullopt, children, result);
    return result;
  }

  std::optional<OpId> predecessor_for_insert(std::size_t index) const {
    auto order = visible_order();
    if (index == 0 || order.empty()) {
      return std::nullopt;
    }
    if (index > order.size()) {
      index = order.size();
    }
    return order[index - 1]->id;
  }

  static void append_visible_elements(
      const std::optional<OpId> &previous,
      const std::map<std::optional<OpId>, std::vector<const Element *>> &children,
      std::vector<const Element *> &result) {
    auto found = children.find(previous);
    if (found == children.end()) {
      return;
    }

    for (const Element *element : found->second) {
      if (!element->removed) {
        result.push_back(element);
      }
      append_visible_elements(element->id, children, result);
    }
  }

  static void append_visible(
      const std::optional<OpId> &previous,
      const std::map<std::optional<OpId>, std::vector<const Element *>> &children,
      std::string &result) {
    auto found = children.find(previous);
    if (found == children.end()) {
      return;
    }

    for (const Element *element : found->second) {
      if (!element->removed) {
        result.push_back(element->value);
      }
      append_visible(element->id, children, result);
    }
  }

  std::map<OpId, Element> elements;
  std::set<OpId> pending_deletes;
};

struct Replica {
  explicit Replica(std::string id) : clock(std::move(id)) {}

  OpId next() { return clock.tick(); }

  void merge_from(const Replica &other) {
    title.merge(other.title);
    tags.merge(other.tags);
    body.merge(other.body);
  }

  LamportClock clock;
  LwwRegister<std::string> title;
  AwSet<std::string> tags;
  RgaText body;
};

// Test
void run_tests() {
  Replica left("left");
  Replica right("right");

  left.title.assign("Meeting notes", left.next());
  right.title.assign("Distributed notes", right.next());
  left.merge_from(right);
  right.merge_from(left);
  assert(left.title.value() == right.title.value());

  left.tags.add("crdt", left.next());
  right.tags.add("networking", right.next());
  left.tags.remove("crdt");
  right.tags.add("crdt", right.next());
  left.merge_from(right);
  right.merge_from(left);
  assert(left.tags.contains("crdt"));
  assert(left.tags.contains("networking"));
  assert(left.tags.values() == right.tags.values());

  auto h = left.body.insert_after(std::nullopt, 'H', left.next());
  auto i = right.body.insert_after(std::nullopt, 'i', right.next());
  left.body.merge(right.body);
  right.body.merge(left.body);
  left.body.erase(h);
  right.body.insert_after(i, '!', right.next());
  left.merge_from(right);
  right.merge_from(left);
  assert(left.body.str() == right.body.str());
  assert(left.body.str() == "i!");

  Replica editor("editor");
  editor.body.insert_at(0, 'H', editor.next());
  editor.body.insert_at(1, 'i', editor.next());
  editor.body.insert_at(1, '!', editor.next());
  assert(editor.body.str() == "H!i");
  auto erased = editor.body.erase_range(1, 1);
  assert(erased.size() == 1);
  assert(editor.body.str() == "Hi");
}

} // namespace crdt

int main(int argc, char **argv) {
  if (argc > 1 && std::string(argv[1]) == "--test") {
    crdt::run_tests();
    std::cout << "Alle CRDT-tester passerte.\n";
    return 0;
  }

  std::cout << "CRDT Notes er en webeditor.\n"
            << "Start serveren med: node server.js\n"
            << "Aapne deretter: http://localhost:3000\n"
            << "Kjor C++-testene med: crdt_notes --test\n";
  return 0;
}
