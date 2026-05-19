#pragma once

#include <compare>
#include <cstddef>
#include <cstdint>
#include <iosfwd>
#include <map>
#include <optional>
#include <set>
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

std::ostream &operator<<(std::ostream &out, const OpId &id);

struct LamportClock {
  explicit LamportClock(std::string replica_id);

  OpId tick();
  void observe(const OpId &remote);

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

  OpId insert_after(std::optional<OpId> previous, char value, OpId id);
  std::optional<OpId> insert_at(std::size_t index, char value, OpId id);
  std::vector<OpId> erase_range(std::size_t index, std::size_t count);
  void erase(const OpId &id);
  void merge(const RgaText &other);
  std::string str() const;
  std::string columnar_encoding() const;

private:
  std::vector<const Element *> visible_order() const;
  std::optional<OpId> predecessor_for_insert(std::size_t index) const;

  static void append_visible_elements(
      const std::optional<OpId> &previous,
      const std::map<std::optional<OpId>, std::vector<const Element *>> &children,
      std::vector<const Element *> &result);

  static void append_visible(
      const std::optional<OpId> &previous,
      const std::map<std::optional<OpId>, std::vector<const Element *>> &children,
      std::string &result);

  std::map<OpId, Element> elements;
  std::set<OpId> pending_deletes;
};

struct Replica {
  explicit Replica(std::string id);

  OpId next();
  void merge_from(const Replica &other);

  LamportClock clock;
  LwwRegister<std::string> title;
  AwSet<std::string> tags;
  RgaText body;
};

} // namespace crdt
