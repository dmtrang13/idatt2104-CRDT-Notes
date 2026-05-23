#include "crdt.hpp"

#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>

namespace {

void expect(bool condition, const std::string &message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

template <typename Function>
void expect_throws(Function function, const std::string &message) {
  try {
    function();
  } catch (const std::invalid_argument &) {
    return;
  }
  throw std::runtime_error(message);
}

void run_tests() {
  crdt::Replica left("left");
  crdt::Replica right("right");

  left.title.assign("Meeting notes", left.next());
  right.title.assign("Distributed notes", right.next());
  left.merge_from(right);
  right.merge_from(left);
  expect(left.title.value() == right.title.value(),
         "LWW registers should converge");
  crdt::LwwRegister<std::string> title_tie;
  title_tie.assign("left", {1, "left"});
  title_tie.assign("right", {1, "right"});
  expect(title_tie.value() == "right",
         "LWW register should resolve equal counters by replica id");

  left.tags.add("crdt", left.next());
  right.tags.add("networking", right.next());
  left.tags.remove("crdt");
  right.tags.add("crdt", right.next());
  left.merge_from(right);
  right.merge_from(left);
  expect(left.tags.contains("crdt"), "AWSet add should win over remove");
  expect(left.tags.contains("networking"), "AWSet merge should keep remote add");
  expect(left.tags.values() == right.tags.values(), "AWSets should converge");
  crdt::AwSet<std::string> removed_tag;
  removed_tag.add("temporary", {1, "tags"});
  removed_tag.remove("temporary");
  removed_tag.remove("temporary");
  expect(!removed_tag.contains("temporary"),
         "AWSet repeated remove should remain idempotent");

  auto h = left.body.insert_after(std::nullopt, "H", left.next());
  auto i = right.body.insert_after(std::nullopt, "i", right.next());
  left.body.merge(right.body);
  right.body.merge(left.body);
  left.body.erase_with(left.next(), h);
  right.body.insert_after(i, "!", right.next());
  left.merge_from(right);
  right.merge_from(left);
  expect(left.body.str() == right.body.str(), "RGA text should converge");
  expect(left.body.str() == "i!", "RGA text should preserve expected order");

  crdt::Replica editor("editor");
  editor.body.insert_at(0, "H", editor.next());
  editor.body.insert_at(1, "i", editor.next());
  editor.body.insert_at(1, "!", editor.next());
  expect(editor.body.str() == "H!i", "RGA insert_at should find predecessor");
  auto erased = editor.body.erase_range(1, 1);
  expect(erased.size() == 1, "RGA erase_range should return erased targets");
  expect(editor.body.str() == "Hi", "RGA erase_range should hide erased text");

  crdt::Replica slow("slow");
  crdt::Replica fast("fast");
  fast.body.insert_after(std::nullopt, "x", fast.next());
  fast.body.insert_after(std::nullopt, "y", fast.next());
  slow.merge_from(fast);
  expect(slow.next().counter == 3,
         "Replica merge should observe remote Lamport history");

  crdt::RgaText duplicate;
  crdt::OpId duplicate_id{1, "replica"};
  duplicate.insert_after(std::nullopt, "a", duplicate_id);
  duplicate.insert_after(std::nullopt, "a", duplicate_id);
  expect(duplicate.str() == "a", "Identical duplicate insert should be idempotent");
  expect_throws(
      [&] { duplicate.insert_after(std::nullopt, "b", duplicate_id); },
      "Conflicting duplicate insert should be rejected");

  crdt::RgaText dangling_left;
  crdt::RgaText dangling_right;
  crdt::OpId parent{1, "remote"};
  crdt::OpId child{2, "remote"};
  dangling_left.insert_after(parent, "b", child);
  expect(dangling_left.str().empty(),
         "Dangling predecessor should stay hidden before parent arrives");
  dangling_right.insert_after(std::nullopt, "a", parent);
  dangling_left.merge(dangling_right);
  expect(dangling_left.str() == "ab",
         "Dangling predecessor should become visible after parent arrives");

  crdt::RgaText deletes;
  crdt::OpId insert_id{1, "csv"};
  crdt::OpId delete_id{2, "csv"};
  deletes.insert_after(std::nullopt, ",", insert_id);
  deletes.erase_with(delete_id, insert_id);
  deletes.erase_with(delete_id, insert_id);
  expect(deletes.str().empty(), "Identical duplicate delete should be idempotent");
  const std::string csv = deletes.columnar_encoding();
  expect(csv.find("delete,2@csv,,1@csv,,true") != std::string::npos,
         "Columnar encoding should include first-class delete operations");
  expect(csv.find("\",\"") != std::string::npos,
         "Columnar encoding should quote comma characters");

  crdt::RgaText pending_delete;
  pending_delete.erase_with({2, "late"}, {1, "late"});
  pending_delete.insert_after(std::nullopt, "x", {1, "late"});
  expect(pending_delete.str().empty(),
         "Delete received before insert should hide the later insert");

  crdt::RgaText repeated_a;
  crdt::RgaText repeated_b;
  repeated_a.insert_after(std::nullopt, "z", {1, "same"});
  repeated_b.merge(repeated_a);
  repeated_b.merge(repeated_a);
  repeated_a.merge(repeated_b);
  expect(repeated_a.str() == repeated_b.str(),
         "Repeated merges should remain idempotent");
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
