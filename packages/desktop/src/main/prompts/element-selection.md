# Page Element Selection

{{#if instruction}}
{{instruction}}
{{else}}
Inspect and edit the selected web page element.
{{/if}}

- **Page URL**: {{url}}
- **Target Selector**: `{{selector}}`
{{#if tagName}}
- **Element Tag**: `<{{tagName}}>`
{{/if}}
{{#if captureMode}}
- **Capture Mode**: {{captureMode}}
{{/if}}
{{#if summary}}
- **Summary**: {{summary}}
{{/if}}
{{#if text}}
- **Text Content**: "{{text}}"
{{/if}}
{{#if screenshotAttached}}
- **Screenshot Attached**: {{screenshotWidth}}×{{screenshotHeight}}px
{{/if}}
{{#if domHtml}}

Element DOM snippet:
```html
{{{domHtml}}}
```
{{/if}}
