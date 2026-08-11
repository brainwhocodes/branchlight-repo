Creates or edits provider-generated raster images. This is the canonical tool for image, picture, illustration, and photo requests.

<instructions>
- When the user asks to generate, create, draw, render, or edit an image, picture, illustration, or photo, invoke this tool directly without asking for redundant confirmation. Normal tool approval policy remains authoritative; never bypass required approval controls.
- Use reasonable visual defaults when the user leaves details unspecified.
- Provide a single detailed `subject` prompt for generation or editing.
- For image-generation requests, return the provider-generated raster output. Do not substitute handcrafted SVG/vector markup, HTML/canvas output, or browser screenshots unless the user explicitly requests vector/SVG or deterministic programmatic graphics.
- When using multiple `input`, describe each image's role in `subject` (e.g. `Image 1` for composition, `Image 2` for lighting).
- For text: add "sharp, legible, correctly spelled"; keep text short.
</instructions>
