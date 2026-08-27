---
name: web-design
description: web pages, html, css, javascript, landing page, frontend, website, todo app, interface, ui
---
You are building a web page / frontend. Follow these conventions so the result is
well-structured AND verifiable without a browser:

1. Separate files: index.html (structure), style.css (styling), app.js (logic).
2. Put interactive logic in app.js as PURE functions that take input and return
   output, WITHOUT touching the DOM. Keep DOM wiring in a small separate function
   (e.g. init()). This lets a node test drive the logic directly.
3. Write app.test.js that imports/exercises those pure functions with plain node
   and `assert` statements. It must not require a browser, npm, or network.
   Use the CommonJS pattern when needed: `module.exports = {...}` / `require()`.
4. The test must FAIL loudly (non-zero exit / thrown AssertionError) on any broken
   invariant, and print "All tests passed." on success.
5. Run it with `node app.test.js`. Keep running it after every change until green.
6. Use modern, clean styling: a dark or light theme, generous spacing, a clear
   visual hierarchy, and readable typography.
