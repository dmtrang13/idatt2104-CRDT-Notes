cmake_minimum_required(VERSION 3.20)
project(crdt_notes LANGUAGES CXX)

option(BUILD_TESTING "Build tests" ON)

if(BUILD_TESTING)
    enable_testing()
endif()

add_library(crdt_core STATIC
    crdt.cpp
    crdt.hpp
)

target_compile_features(crdt_core PUBLIC cxx_std_20)
target_include_directories(crdt_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})

add_executable(crdt_notes
    crdt_tests.cpp
)

target_link_libraries(crdt_notes PRIVATE crdt_core)

set_target_properties(crdt_core crdt_notes PROPERTIES
    CXX_STANDARD 20
    CXX_STANDARD_REQUIRED YES
    CXX_EXTENSIONS NO
)

# Compiler warnings
if(MSVC)
    foreach(target crdt_core crdt_notes)
        target_compile_options(${target} PRIVATE
            /W4
            /permissive-
        )
    endforeach()
else()
    foreach(target crdt_core crdt_notes)
        target_compile_options(${target} PRIVATE
            -Wall
            -Wextra
            -Wpedantic
        )
    endforeach()
endif()

# Platform-specific settings
if(WIN32)
    target_compile_definitions(crdt_core PUBLIC PLATFORM_WINDOWS)

    if(MINGW)
        target_link_options(crdt_notes PRIVATE
            -static-libgcc
            -static-libstdc++
        )
    endif()

elseif(APPLE)
    target_compile_definitions(crdt_core PUBLIC PLATFORM_APPLE)

elseif(UNIX)
    target_compile_definitions(crdt_core PUBLIC PLATFORM_UNIX)
endif()

if(BUILD_TESTING)
    add_test(NAME crdt_notes_tests COMMAND $<TARGET_FILE:crdt_notes> --test)

    if(WIN32 AND MINGW)
        set_tests_properties(crdt_notes_tests PROPERTIES
            ENVIRONMENT "PATH=C:/msys64/ucrt64/bin;$ENV{PATH}"
        )
    endif()
endif()
