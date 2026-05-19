#include "crdt.hpp"

#include <algorithm>
#include <ostream>
#include <sstream>

namespace crdt {

std::ostream &operator<<(std::ostream &out, const OpId &id) {
  return out << id.counter << "@" << id.replica;
}

LamportClock::LamportClock(std::string replica_id)
    : replica(std::move(replica_id)) {}

OpId LamportClock::tick() { return OpId{++counter, replica}; }

void LamportClock::observe(const OpId &remote) {
  counter = std::max(counter, remote.counter);
}

OpId RgaText::insert_after(std::optional<OpId> previous, char value, OpId id) {
  elements[id] = Element{id, std::move(previous), value, false};
  return id;
}

std::optional<OpId> RgaText::insert_at(std::size_t index, char value, OpId id) {
  auto previous = predecessor_for_insert(index);
  insert_after(previous, value, id);
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
  auto found = elements.find(id);
  if (found != elements.end()) {
    found->second.removed = true;
  } else {
    pending_deletes.insert(id);
  }
}

void RgaText::merge(const RgaText &other) {
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

std::string RgaText::str() const {
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

std::string RgaText::columnar_encoding() const {
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

std::vector<const RgaText::Element *> RgaText::visible_order() const {
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

void RgaText::append_visible_elements(
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

void RgaText::append_visible(
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

Replica::Replica(std::string id) : clock(std::move(id)) {}

OpId Replica::next() { return clock.tick(); }

void Replica::merge_from(const Replica &other) {
  title.merge(other.title);
  tags.merge(other.tags);
  body.merge(other.body);
}

} // namespace crdt
