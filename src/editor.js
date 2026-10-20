import Quill from 'quill'
import QuillCursors from 'quill-cursors'
import { QuillBinding } from 'y-quill'
import katex from 'katex'

// Quill's formula format looks KaTeX up on window
window.katex = katex

// Every boolean is opt-in: the settings form saves unticked boxes as false
const DEFAULTS = {
  editorId: '',
  synchronize: false,
  placeholder: '',
  toolbar: 'full',
  readOnly: false,
  maxImageKB: 500,
  blockRemoteImages: false,
}

// Uploaded images are scaled to fit this box (px) unless they are already small enough
const MAX_IMAGE_SIDE = 1280
const JPEG_QUALITIES = [0.85, 0.7, 0.5]

const TOOLBARS = {
  full: [
    ['bold', 'italic', 'underline', 'strike'],
    ['blockquote', 'code-block'],
    ['link', 'image', 'video', 'formula'],
    [{ header: 1 }, { header: 2 }],
    [{ list: 'ordered' }, { list: 'bullet' }, { list: 'check' }],
    [{ script: 'sub' }, { script: 'super' }],
    [{ indent: '-1' }, { indent: '+1' }],
    [{ direction: 'rtl' }],
    [{ size: ['small', false, 'large', 'huge'] }],
    [{ header: [1, 2, 3, 4, 5, 6, false] }],
    [{ color: [] }, { background: [] }],
    [{ font: [] }],
    [{ align: [] }],
    ['clean'],
  ],
  basic: [
    ['bold', 'italic', 'underline', 'strike'],
    [{ header: 1 }, { header: 2 }],
    [{ list: 'ordered' }, { list: 'bullet' }, { list: 'check' }],
    ['link', 'image', 'formula'],
    ['clean'],
  ],
}

// Videos can only come from these players; everything else is blocked for every peer
const VIDEO_URL =
  /^https:\/\/(www\.youtube\.com\/embed\/|www\.youtube-nocookie\.com\/embed\/|player\.vimeo\.com\/video\/)/

// Config fields arrive JSON-parsed, or as a string/undefined when unset or invalid
const asObject = (c) => (c && typeof c === 'object' ? c : {})

function readConfig() {
  const merged = { ...DEFAULTS }
  const sources = [
    Edrys.module.config,
    Edrys.module[Edrys.role.toLowerCase() + 'Config'],
  ]
  for (const source of sources) {
    for (const [key, value] of Object.entries(asObject(source))) {
      // the settings form saves empty fields as '': keep the default then
      if (value !== '' && value !== undefined) merged[key] = value
    }
  }
  return merged
}

// An empty editorId keeps the original key, so existing documents stay where they are
const stateKey = (cfg) =>
  cfg.editorId ? `quill-text-${cfg.editorId}` : 'quill-text'

const status = document.getElementById('status')

function showError(error) {
  console.error('Editor initialization error:', error)
  status.classList.add('error')
  status.setAttribute('role', 'alert')
  status.textContent =
    `Could not start the editor: ${error?.message || error}. ` +
    'Reload the page; if this keeps happening, check the module URL in the class settings.'
  status.hidden = false
}

// A short message above the toolbar that goes away by itself
let noticeTimer
function notify(message) {
  clearTimeout(noticeTimer)
  status.className = 'notice'
  status.setAttribute('role', 'status')
  status.textContent = message
  status.hidden = false
  noticeTimer = setTimeout(() => (status.hidden = true), 8000)
}

/**
 * Video embeds render peer-supplied URLs for everyone: allow only known
 * players, sandboxed. Blocked URLs show a note instead of the page.
 */
function registerSafeVideo() {
  const Video = Quill.import('formats/video')
  class SafeVideo extends Video {
    static sanitize(url) {
      // Quill keeps the scheme of a pasted watch link: upgrade http players to https
      const secure = String(url).replace(/^http:\/\//, 'https://')
      return VIDEO_URL.test(secure) ? secure : 'about:blank'
    }
    static create(value) {
      const node = super.create(value)
      if (node.getAttribute('src') === 'about:blank') {
        node.setAttribute('sandbox', '')
        node.setAttribute(
          'srcdoc',
          '<p style="font: 14px system-ui, sans-serif; color: #888">' +
            'Video blocked: only YouTube and Vimeo videos can be embedded.</p>'
        )
      } else {
        node.setAttribute(
          'sandbox',
          'allow-scripts allow-same-origin allow-presentation allow-popups'
        )
      }
      return node
    }
  }
  Quill.register(SafeVideo, true)
}

/** With blockRemoteImages, only images stored in the document (data: URLs) are shown. */
function registerImageFormat(cfg) {
  if (cfg.blockRemoteImages !== true) return
  const Image = Quill.import('formats/image')
  class LocalImage extends Image {
    static sanitize(url) {
      return /^data:image\//.test(url) ? url : '//:0'
    }
  }
  Quill.register(LocalImage, true)
}

const dataUrlBytes = (url) => Math.ceil(((url.length - url.indexOf(',') - 1) * 3) / 4)

const readDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

/**
 * The image as a data: URL of at most maxBytes: unchanged if it already fits
 * (keeps PNG transparency and GIF animation), otherwise scaled down to
 * MAX_IMAGE_SIDE and re-encoded as JPEG. Throws if it cannot be made to fit.
 */
async function shrinkImage(file, maxBytes) {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(`"${file.name}" could not be read as an image`)
  })
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height))
  if (scale === 1 && file.size <= maxBytes) {
    bitmap.close()
    return readDataUrl(file)
  }

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const context = canvas.getContext('2d')
  // JPEG has no transparency: put transparent images on white
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  for (const quality of JPEG_QUALITIES) {
    const url = canvas.toDataURL('image/jpeg', quality)
    if (dataUrlBytes(url) <= maxBytes) return url
  }
  throw new Error(
    `"${file.name}" is too large even after scaling it down (limit ${maxBytes / 1024} KB)`
  )
}

/** Quill uploader handler (toolbar button, paste and drop): shrink, then insert. */
function imageUploader(cfg) {
  const maxBytes = (Number(cfg.maxImageKB) || DEFAULTS.maxImageKB) * 1024
  return async function (range, files) {
    let index = range.index
    this.quill.deleteText(range.index, range.length, 'user')
    for (const file of files) {
      try {
        const url = await shrinkImage(file, maxBytes)
        this.quill.insertEmbed(index++, 'image', url, 'user')
      } catch (error) {
        notify(`Image not added: ${error.message}.`)
      }
    }
    this.quill.setSelection(index, 'silent')
  }
}

// Deterministic hue from a string, so a person has the same cursor colour
// everywhere (same as module-monaco-editor)
function stringToHue(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }
  return Math.abs(hash) % 360
}

// Peer names are raw identities: a base64 ECDSA key with a `_xxxxx` session
// suffix, or a plain name for stations. Mirrors edrys's getShortPeerID() so the
// cursor label matches the rooms list (same as module-monaco-editor).
function shortPeerName(rawName) {
  const sepIdx = rawName.lastIndexOf('_')
  const base = sepIdx > 0 ? rawName.slice(0, sepIdx) : rawName
  if (!/^[A-Za-z0-9+/]{40,}={0,2}$/.test(base)) return base.slice(0, 16)
  try {
    const bytes = Uint8Array.from(atob(base), (c) => c.charCodeAt(0))
    return Array.from(bytes.slice(0, 4))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return base.slice(0, 16)
  }
}

/**
 * Live cursors of the others in the room. y-quill draws them with
 * quill-cursors from each peer's awareness `user` and `cursor` fields.
 */
function joinCursors(key) {
  try {
    const awareness = Edrys.getState(`${key}-cursors`, 'Awareness')
    const name = shortPeerName(Edrys.username || 'anon')
    awareness.setLocalStateField('user', {
      name,
      color: `hsl(${stringToHue(name)}, 70%, 45%)`,
    })
    // edrys.js keeps awareness state after the page is gone: drop our cursor
    window.addEventListener('pagehide', () =>
      awareness.setLocalStateField('cursor', null)
    )
    return awareness
  } catch (error) {
    console.warn('Live cursors are not available:', error)
    return undefined
  }
}

/** One shared Y.Text for the room, followed when it is replaced. */
function bindShared(editor, key, awareness) {
  // getState creates the Y.Text when the key is missing. Peers that do this
  // at the same moment each create one and Yjs keeps only one, so rebind
  // whenever the key's value is replaced, or this peer edits a dropped text.
  let ytext = Edrys.getState(key, 'Text')
  let binding = new QuillBinding(ytext, editor, awareness)
  window.ytext = ytext

  Edrys.getState().observe((event) => {
    if (!event.keysChanged.has(key)) return
    const current = Edrys.getState(key, 'Text')
    if (current === ytext) return
    binding.destroy()
    ytext = current
    binding = new QuillBinding(ytext, editor, awareness)
    window.ytext = ytext
  })
}

/** Without synchronize: this person's own copy, kept in their browser (per class and room). */
function bindLocal(editor, key) {
  const storageKey = `${key}-local`
  try {
    const saved = Edrys.getItem(storageKey)
    if (saved) {
      editor.setContents(JSON.parse(saved), 'silent')
      editor.history.clear()
    }
  } catch (error) {
    console.warn('Could not restore the local copy:', error)
  }

  const save = () => {
    try {
      Edrys.setItem(storageKey, JSON.stringify(editor.getContents()))
    } catch (error) {
      notify(`Could not save your copy in this browser: ${error.message}.`)
    }
  }
  let timer
  editor.on('text-change', () => {
    clearTimeout(timer)
    timer = setTimeout(save, 500)
  })
  window.addEventListener('pagehide', save)
}

const SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'

// Hover text (and screen-reader label) per toolbar control: Quill only sets
// terse aria-labels such as "list: ordered". Keys: format, or format:value.
const TOOL_LABELS = {
  bold: `Bold (${SHORTCUT}B)`,
  italic: `Italic (${SHORTCUT}I)`,
  underline: `Underline (${SHORTCUT}U)`,
  strike: 'Strikethrough',
  blockquote: 'Quote',
  'code-block': 'Code block',
  link: `Link (${SHORTCUT}K)`,
  image: 'Image',
  video: 'Video (YouTube or Vimeo)',
  formula: 'Formula (LaTeX)',
  'header:1': 'Heading 1',
  'header:2': 'Heading 2',
  'list:ordered': 'Numbered list',
  'list:bullet': 'Bulleted list',
  'list:check': 'Checklist',
  'script:sub': 'Subscript',
  'script:super': 'Superscript',
  'indent:-1': 'Decrease indent',
  'indent:+1': 'Increase indent',
  'direction:rtl': 'Right-to-left text',
  clean: 'Clear formatting',
  size: 'Text size',
  header: 'Heading',
  color: 'Text colour',
  background: 'Highlight colour',
  font: 'Font',
  align: 'Alignment',
}

function labelToolbar(editor) {
  const toolbar = editor.getModule('toolbar').container
  const formatOf = (el) =>
    [...el.classList].find((c) => c.startsWith('ql-') && c !== 'ql-picker')?.slice(3)
  const label = (el, text) => {
    if (!text) return
    el.title = text
    el.setAttribute('aria-label', text)
  }
  for (const button of toolbar.querySelectorAll('button')) {
    const format = formatOf(button)
    const value = button.value
    label(button, TOOL_LABELS[value ? `${format}:${value}` : format] || TOOL_LABELS[format])
  }
  // pickers (size, heading, colours, font, alignment): label their opener
  for (const picker of toolbar.querySelectorAll('.ql-picker')) {
    label(picker.querySelector('.ql-picker-label'), TOOL_LABELS[formatOf(picker)])
  }
}

/** "shared" / "local only" at the end of the toolbar. */
function showSyncBadge(editor, sync) {
  const group = document.createElement('span')
  group.className = 'ql-formats sync'
  const badge = document.createElement('span')
  badge.className = `badge ${sync ? 'on' : 'wait'}`
  badge.textContent = sync ? 'shared' : 'local only'
  badge.title = sync
    ? 'Shared: everyone in this room edits this document'
    : 'Local only: your own copy, kept in this browser'
  group.append(badge)
  editor.getModule('toolbar').container.append(group)
}

async function initializeEditor() {
  // onReady only fires inside an Edrys classroom
  const slow = setTimeout(() => {
    status.textContent =
      'Still waiting for the classroom to connect… This editor only works inside Edrys.'
  }, 10_000)

  try {
    // Wait for Edrys to be ready
    await new Promise((resolve) => Edrys.onReady(resolve))
    clearTimeout(slow)

    const cfg = readConfig()
    const STATE_KEY = stateKey(cfg)
    const sync = cfg.synchronize === true
    const readOnly = cfg.readOnly === true

    Quill.register('modules/cursors', QuillCursors)
    registerSafeVideo()
    registerImageFormat(cfg)

    const editor = new Quill('#editor-container', {
      modules: {
        uploader: {
          mimetypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
          handler: imageUploader(cfg),
        },
        cursors: { transformOnTextChange: true },
        toolbar: TOOLBARS[cfg.toolbar] || TOOLBARS.full,
      },
      theme: 'snow',
      readOnly,
      placeholder:
        cfg.placeholder ||
        (readOnly
          ? 'Nothing here yet.'
          : sync
            ? 'Start collaborating...'
            : 'Start writing...'),
    })

    // Read-only users never use the toolbar: hide it rather than show dead buttons
    if (readOnly) editor.getModule('toolbar').container.hidden = true
    labelToolbar(editor)
    showSyncBadge(editor, sync)

    if (sync) bindShared(editor, STATE_KEY, joinCursors(STATE_KEY))
    else bindLocal(editor, STATE_KEY)

    // used by the e2e tests (edrys-module-tests), with window.ytext in shared mode
    window.editor = editor

    status.hidden = true
  } catch (error) {
    clearTimeout(slow)
    showError(error)
  }
}

initializeEditor()
