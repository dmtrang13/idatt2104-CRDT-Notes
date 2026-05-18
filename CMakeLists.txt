cmake_minimum_required(VERSION 3.20)
project(crdt_notes LANGUAGES CXX)

option(BUILD_TESTING "Build tests" ON)

if(BUILD_TESTING)
    enable_testing()
endif()

add_executable(crdt_notes
    crdt.cpp
)

target_compile_features(crdt_notes PRIVATE cxx_std_20)

set_target_properties(crdt_notes PROPERTIES
    CXX_STANDARD 20
    CXX_STANDARD_REQUIRED YES
    CXX_EXTENSIONS NO
)

# Compiler warnings
if(MSVC)
    target_compile_options(crdt_notes PRIVATE
        /W4
        /permissive-
    )
else()
    target_compile_options(crdt_notes PRIVATE
        -Wall
        -Wextra
        -Wpedantic
    )
endif()

# Platform-specific settings
if(WIN32)
    target_compile_definitions(crdt_notes PRIVATE PLATFORM_WINDOWS)

    if(MINGW)
        target_link_options(crdt_notes PRIVATE
            -static-libgcc
            -static-libstdc++
        )
    endif()

elseif(APPLE)
    target_compile_definitions(crdt_notes PRIVATE PLATFORM_APPLE)

elseif(UNIX)
    target_compile_definitions(crdt_notes PRIVATE PLATFORM_UNIX)
endif()

if(BUILD_TESTING)
    add_test(NAME crdt_notes_tests COMMAND $<TARGET_FILE:crdt_notes> --test)

    if(WIN32 AND MINGW)
        set_tests_properties(crdt_notes_tests PROPERTIES
            ENVIRONMENT "PATH=C:/msys64/ucrt64/bin;$ENV{PATH}"
        )
    endif()
endif()
