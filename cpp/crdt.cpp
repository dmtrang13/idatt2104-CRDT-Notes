#include "crdt.hpp"

#include <algorithm>
#include <iterator>
#include <ostream>
#include <sstream>
#include <stdexcept>

namespace crdt {
namespace {

std::string csv_field(std::string value) {
  bool needs_quotes = false;
  std::string escaped;
  for (char ch : value) {
    if (ch == '"') {
      escaped += "\"\"";
      needs_quotes = true;
    } else {
      escaped += ch;
    }

    if (ch == ',' || ch == '\n' || ch == '\r') {
      needs_quotes = true;
    }
  }

  if (!needs_quotes) {
    return escaped;
  }
  return "\"" + escaped + "\"";
}

std::string op_id_to_string(const OpId &id) {
  std::ostringstream out;
  out << id;
  return out.str();
}

} // namespace

std::ostream &operator<<(std::ostream &out, const OpId &id) {
  return out << id.counter << "@" << id.replica;
}

LamportClock::LamportClock(std::string replica_id)
    : replica(std::move(replica_id)) {}

OpId LamportClock::tick() { return OpId{++counter, replica}; }

void LamportClock::observe(const OpId &remote) {
  counter = std::max(counter, remote.counter);
}

OpId RgaText::insert_after(std::optional<OpId> previous, std::string value,
                            OpId id) {
  Element element{id, std::move(previous), std::move(value),
                  pending_deletes.contains(id)};
  auto [it, inserted] = elements.emplace(id, element);
  if (!inserted) {
    const bool same_previous = it->second.previous == element.previous;
    if (!same_previous || it->second.value != element.value) {
      throw std::invalid_argument("conflicting RGA insert operation id");
    }
    it->second.removed = it->second.removed || element.removed;
  }
  return id;
}

std::optional<OpId> RgaText::insert_at(std::size_t index, std::string value,
                                       OpId id) {
  auto previous = predecessor_for_insert(index);
  insert_after(previous, std::move(value), id);
  return id;
}

std::vector<OpId> RgaText::erase_range(std::size_t index, std::size_t count) {
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

void RgaText::erase(const OpId &id) {
  pending_deletes.insert(id);
  auto found = elements.find(id);
  if (found != elements.end()) {
    found->second.removed = true;
  }
}

OpId RgaText::erase_with(OpId delete_id, OpId target) {
  auto [it, inserted] =
      deletes.emplace(delete_id, DeleteOperation{delete_id, target});
  if (!inserted && it->second.target != target) {
    throw std::invalid_argument("conflicting RGA delete operation id");
  }
  erase(target);
  return delete_id;
}

void RgaText::merge(const RgaText &other) {
  for (const auto &[id, element] : other.elements) {
    auto [it, inserted] = elements.emplace(id, element);
    if (!inserted) {
      if (it->second.previous != element.previous ||
          it->second.value != element.value) {
        throw std::invalid_argument("conflicting RGA insert operation id");
      }
      it->second.removed = it->second.removed || element.removed;
    }
  }

  for (const auto &[id, deletion] : other.deletes) {
    auto [it, inserted] = deletes.emplace(id, deletion);
    if (!inserted && it->second.target != deletion.target) {
      throw std::invalid_argument("conflicting RGA delete operation id");
    }
  }

  pending_deletes.insert(other.pending_deletes.begin(),
                         other.pending_deletes.end());
  for (const auto &[_, deletion] : deletes) {
    pending_deletes.insert(deletion.target);
  }
  for (const auto &id : pending_deletes) {
    auto found = elements.find(id);
    if (found != elements.end()) {
      found->second.removed = true;
    }
  }
}

std::string RgaText::str() const {
  std::string result;
  for (const Element *element : visible_order()) {
    result += element->value;
  }
  return result;
}

std::string RgaText::columnar_encoding() const {
  std::ostringstream out;
  out << "type,op_id,ref_id,target_id,char,removed\n";
  for (const auto &[id, element] : elements) {
    out << "insert," << csv_field(op_id_to_string(id)) << ",";
    if (element.previous) {
      out << csv_field(op_id_to_string(*element.previous));
    } else {
      out << "ROOT";
    }
    out << ",," << csv_field(element.value) << ","
        << (element.removed ? "true" : "false") << "\n";
  }

  for (const auto &[id, deletion] : deletes) {
    out << "delete," << csv_field(op_id_to_string(id)) << ",,"
        << csv_field(op_id_to_string(deletion.target)) << ",,true\n";
  }
  return out.str();
}

std::vector<const RgaText::Element *> RgaText::visible_order() const {
  std::map<std::optional<OpId>, std::vector<const Element *>> children;
  for (const auto &[_, element] : elements) {
    children[element.previous].push_back(&element);
  }

  for (auto &[_, siblings] : children) {
    // Higher OpIds are ordered first for concurrent siblings. This matches the
    // JavaScript demo and gives a deterministic add-wins traversal.
    std::ranges::sort(siblings, [](const Element *left, const Element *right) {
      return right->id < left->id;
    });
  }

  std::vector<const Element *> result;
  std::vector<const Element *> stack;
  if (auto root = children.find(std::nullopt); root != children.end()) {
    stack.insert(stack.end(), root->second.rbegin(), root->second.rend());
  }

  while (!stack.empty()) {
    const Element *element = stack.back();
    stack.pop_back();

    if (!element->removed) {
      result.push_back(element);
    }

    if (auto found = children.find(element->id); found != children.end()) {
      stack.insert(stack.end(), found->second.rbegin(), found->second.rend());
    }
  }

  return result;
}

std::optional<OpId> RgaText::predecessor_for_insert(std::size_t index) const {
  auto order = visible_order();
  if (index == 0 || order.empty()) {
    return std::nullopt;
  }
  if (index > order.size()) {
    index = order.size();
  }
  return order[index - 1]->id;
}

std::optional<OpId> RgaText::max_observed() const {
  std::optional<OpId> result;
  const auto observe = [&result](const OpId &id) {
    if (!result || *result < id) {
      result = id;
    }
  };

  for (const auto &[id, element] : elements) {
    observe(id);
    if (element.previous) {
      observe(*element.previous);
    }
  }
  for (const auto &[id, deletion] : deletes) {
    observe(id);
    observe(deletion.target);
  }
  for (const auto &id : pending_deletes) {
    observe(id);
  }
  return result;
}

Replica::Replica(std::string id) : clock(std::move(id)) {}

OpId Replica::next() { return clock.tick(); }

void Replica::merge_from(const Replica &other) {
  title.merge(other.title);
  tags.merge(other.tags);
  body.merge(other.body);
  clock.observe(OpId{other.clock.counter, other.clock.replica});
  if (auto title_id = other.title.max_observed()) {
    clock.observe(*title_id);
  }
  if (auto tags_id = other.tags.max_observed()) {
    clock.observe(*tags_id);
  }
  if (auto body_id = other.body.max_observed()) {
    clock.observe(*body_id);
  }
}

} // namespace crdt