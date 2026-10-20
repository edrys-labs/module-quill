// edrys.js bundles Yjs and exposes it as window.Y. y-quill must use that same
// copy: the shared Y.Text and the awareness come from it, and cursor positions
// (Y.RelativePosition) are only resolved correctly by the Yjs that created them.
module.exports = window.Y
