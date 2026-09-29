cmake_minimum_required(VERSION 3.22.1)
project(clutch_native LANGUAGES CXX)

# Our JNI shim (see native-lib.cpp)…
add_library(native-lib SHARED native-lib.cpp)

# …dynamically linked against the pinned nodejs-mobile libnode.so that
# scripts/fetch-android-libnode.sh places in jniLibs/<abi>/ (AGP packages it;
# useLegacyPackaging makes the linker resolve it by soname at load time).
add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION
        ${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so)
target_include_directories(native-lib PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)

find_library(log-lib log)
target_link_libraries(native-lib node ${log-lib})
