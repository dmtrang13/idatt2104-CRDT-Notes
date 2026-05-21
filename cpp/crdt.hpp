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
  // Concurrent assignments with equal counters are resolved by OpId ordering:
  // the lexicographically larger replica id wins. This is deterministic, but
  // intentionally visible to callers that use LWW fields for user data.
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

  std::optional<OpId> max_observed() const {
    if (!state) {
      return std::nullopt;
    }
    return state->time;
  }

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

  std::optional<OpId> max_observed() const {
    std::optional<OpId> result;
    const auto observe = [&result](const OpId &id) {
      if (!result || *result < id) {
        result = id;
      }
    };

    for (const auto &[_, dots] : additions) {
      for (const auto &dot : dots) {
        observe(dot);
      }
    }
    for (const auto &[_, dots] : removals) {
      for (const auto &dot : dots) {
        observe(dot);
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
    std::string value;
    bool removed{};
  };

  struct DeleteOperation {
    OpId id;
    OpId target;
  };

  OpId insert_after(std::optional<OpId> previous, std::string value, OpId id);
  std::optional<OpId> insert_at(std::size_t index, std::string value, OpId id);
  std::vector<OpId> erase_range(std::size_t index, std::size_t count);
  void erase(const OpId &id);
  OpId erase_with(OpId delete_id, OpId target);
  void merge(const RgaText &other);
  std::string str() const;
  std::string columnar_encoding() const;
  std::optional<OpId> max_observed() const;

private:
  std::vector<const Element *> visible_order() const;
  std::optional<OpId> predecessor_for_insert(std::size_t index) const;

  std::map<OpId, Element> elements;
  std::map<OpId, DeleteOperation> deletes;
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