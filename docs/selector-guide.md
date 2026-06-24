# Gemini DOM Selector Guide

When Google updates the Gemini UI, selectors in `codebase/content/content.js` (the `SEL` object at the top) may break. This doc explains how to find updated selectors.

## How to Inspect the Live DOM

1. Open `https://gemini.google.com/app` and sign in
2. Press **F12** → open DevTools
3. Use the **Elements panel** or run snippets in the **Console**

## Finding the Input Field

The text input is typically a Quill `contenteditable` div inside a custom web component:

```js
// Run in Console to find candidate selectors:
document.querySelectorAll('[contenteditable="true"]')
document.querySelectorAll('div.ql-editor')
document.querySelector('rich-textarea')
```

Expected structure (may vary):
```html
<rich-textarea>
  <div class="ql-editor" contenteditable="true" data-placeholder="Enter a prompt here">
    <p><br></p>
  </div>
</rich-textarea>
```

## Finding the Submit Button

```js
document.querySelectorAll('button[aria-label]')
// Look for one with label like "Send message", "Submit", "Run"

// Or inspect near the input area:
document.querySelector('.input-area-container').querySelectorAll('button')
```

## Finding Response Containers

After a prompt is submitted, model responses appear in custom elements:

```js
document.querySelectorAll('model-response')
document.querySelectorAll('[data-test-id="response"]')
document.querySelectorAll('message-content')
```

## Finding the Stop Button

While Gemini is generating, a stop button appears:

```js
document.querySelector('button[aria-label="Stop generating"]')
```

## Finding Generated Images

After a generation completes, look for `<img>` tags in the last response:

```js
const responses = document.querySelectorAll('model-response')
const last = responses[responses.length - 1]
last.querySelectorAll('img')
```

Image src URLs typically look like:
- `https://generativelanguage.googleapis.com/...`
- `https://lh3.googleusercontent.com/...`

## Updating Selectors

Edit the `SEL` constant at the top of `codebase/content/content.js`. Add new working selectors at the **front** of each array (highest priority):

```js
const SEL = {
  input: [
    'div.new-working-selector',   // ← add here
    'div.ql-editor[contenteditable="true"]',
    // ...existing fallbacks...
  ],
  // ...
};
```

Do not remove old selectors — they may work again in future Gemini versions.
