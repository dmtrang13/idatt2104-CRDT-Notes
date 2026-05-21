#include "crdt.hpp"

#include <emscripten/bind.h>

#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>

namespace {

crdt::OpId parse_op_id(const std::string &value) {
  const std::size_t at = value.find('@');
  if (at == std::string::npos || at == 0 || at + 1 >= value.size()) {
    throw std::invalid_argument("invalid operation id");
  }

  std::size_t parsed = 0;
  const unsigned long long counter = std::stoull(value.substr(0, at), &parsed);
  if (parsed != at) {
    throw std::invalid_argument("invalid operation counter");
  }

  return crdt::OpId{static_cast<std::uint64_t>(counter),
                    value.substr(at + 1)};
}

std::optional<crdt::OpId> parse_optional_op_id(const std::string &value) {
  if (value.empty() || value == "ROOT") {
    return std::nullopt;
  }
  return parse_op_id(value);
}

} // namespace

class WasmDocument {
public:
  void insert_after(std::string previous, std::string value, std::string id) {
    body.insert_after(parse_optional_op_id(previous), std::move(value),
                      parse_op_id(id));
  }

  void erase(std::string target) { body.erase(parse_op_id(target)); }

  void erase_with(std::string id, std::string target) {
    body.erase_with(parse_op_id(id), parse_op_id(target));
  }

  std::string text() const { return body.str(); }

  std::string columns() const { return body.columnar_encoding(); }

private:
  crdt::RgaText body;
};

EMSCRIPTEN_BINDINGS(crdt_module) {
  emscripten::class_<WasmDocument>("WasmDocument")
      .constructor<>()
      .function("insertAfter", &WasmDocument::insert_after)
      .function("erase", &WasmDocument::erase)
      .function("eraseWith", &WasmDocument::erase_with)
      .function("text", &WasmDocument::text)
      .function("columns", &WasmDocument::columns);
}