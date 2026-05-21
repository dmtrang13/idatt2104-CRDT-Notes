// Placeholder for connecting the JavaScript backend to the C++ CRDT core.
//
// The current web backend persists and relays operation objects directly in
// server.js. This file marks the intended boundary for a future native addon,
// child-process bridge, or WebAssembly integration that can call cpp/crdt.cpp.
