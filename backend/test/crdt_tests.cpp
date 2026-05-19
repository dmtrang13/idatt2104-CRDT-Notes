#include "crdt.hpp"

#include <cassert>
#include <iostream>
#include <optional>
#include <string>

namespace {

void run_tests() {
  crdt::Replica left("left");
  crdt::Replica right("right");

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

  crdt::Replica editor("editor");
  editor.body.insert_at(0, 'H', editor.next());
  editor.body.insert_at(1, 'i', editor.next());
  editor.body.insert_at(1, '!', editor.next());
  assert(editor.body.str() == "H!i");
  auto erased = editor.body.erase_range(1, 1);
  assert(erased.size() == 1);
  assert(editor.body.str() == "Hi");
}

} // namespace

int main(int argc, char **argv) {
  if (argc > 1 && std::string(argv[1]) == "--test") {
    run_tests();
    std::cout << "Alle CRDT-tester passerte.\n";
    return 0;
  }

  std::cout << "CRDT Notes er en webeditor.\n"
            << "Start serveren med: node server.js\n"
            << "Aapne deretter: http://localhost:3000\n"
            << "Kjor C++-testene med: crdt_notes --test\n";
  return 0;
}
