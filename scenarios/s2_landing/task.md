Read content.md in the sandbox and turn it into a polished, modern landing page for the clutch coding agent.

Requirements:
1. Three files: index.html (structure), style.css (styling), app.js (interactivity).
2. The page must include: a hero section with the product name and one-line tagline,
   a "How it works" section (the numbered loop), a "Key design ideas" section,
   a tech stack strip, and a footer. Use the real content from content.md.
3. Make it look like a real developer-tool product page: dark theme, clean typography,
   good spacing, a distinctive accent color.
4. Add TWO interactive features in app.js:
   a. a theme toggle (light/dark) that switches a data-theme attribute on <html>, and
   b. an animated "event stream" demo: a small box that cycles through fake events
      like step_start -> tool_call -> tool_result -> final, updating on a timer.
5. Structure the interactive logic in app.js as PURE functions (no DOM access inside):
   e.g. nextEvent(prev) -> next event, toggleTheme(mode) -> new mode. Keep DOM
   manipulation only inside init(). This lets app.test.js test the logic with node.
6. Write app.test.js that requires app.js, runs the pure functions with node assert:
   - nextEvent cycles step_start -> tool_call -> tool_result -> final -> step_start
   - toggleTheme('dark') -> 'light', toggleTheme('light') -> 'dark'
   - the event cycle list is not empty
   Print "All tests passed." on success and exit 0; exit non-zero on any failure.
7. Run `node app.test.js` until it passes, and make sure `node -e "require('./app.js')"`
   loads without errors (no browser-only globals at module top level).

When the verification gate runs `node app.test.js` it must exit 0.
