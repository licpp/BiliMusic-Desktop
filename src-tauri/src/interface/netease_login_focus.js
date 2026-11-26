// Injected into the NetEase login page (desktop login window, and Android's
// main webview while it shows that page) on every 500 ms poll. The login box
// does not always land inside the viewport — in a narrow window the card also
// overflows sideways — so the user had to hunt for the QR code before scanning.
//
// The page ships build-hashed class names, so nothing here depends on them.
// The QR is recognised by shape and context instead:
//   1. a square <canvas> between 96 and 420 px — the current build renders the
//      QR as a 202 px canvas scaled to 152 px;
//   2. the container of the 「扫码登录」 label, which the QR always follows.
// Square <img>/<svg> elements are deliberately not trusted on their own: the
// page carries square avatars and icons, and centring one of those instead of
// the QR is worse than not scrolling at all.
//
// It only scrolls while the QR is out of view, stops for good as soon as the
// user scrolls, clicks or types (so it never fights a user who is filling in
// the form), and does nothing outside a 163.com document — a delayed eval that
// lands on the app page after a cancel is therefore a no-op.
(function () {
  if (!/(^|\.)163\.com$/i.test(location.hostname)) return
  // Set by the one-time listener below once the user takes over.
  if (window.__bilimusicQrUserMoved) return
  // A poll can run this twice in a row; a page scan is not free.
  var now = Date.now()
  var last = window.__bilimusicQrTick
  if (typeof last === 'number' && now - last >= 0 && now - last < 400) return
  window.__bilimusicQrTick = now

  var LABEL = '扫码登录'
  var MIN_SIZE = 96
  var MAX_SIZE = 420
  var MARGIN = 8
  var MAX_FRAMES = 8

  function markUserMove() {
    window.__bilimusicQrUserMoved = true
  }

  // The login form sits in a same-origin frame, so scrolling and typing happen
  // in that window and never bubble here. Listen in every document we can read.
  function listen(win) {
    if (!win || win.__bilimusicQrListening) return
    try {
      win.__bilimusicQrListening = true
    } catch (error) {
      return
    }
    var options = { capture: true, passive: true, once: true }
    win.addEventListener('wheel', markUserMove, options)
    win.addEventListener('touchstart', markUserMove, options)
    win.addEventListener('pointerdown', markUserMove, options)
    win.addEventListener('keydown', markUserMove, options)
  }

  function rectOf(node) {
    var rect
    try {
      rect = node.getBoundingClientRect()
    } catch (error) {
      return null
    }
    if (!rect || !rect.width || !rect.height) return null
    return rect
  }

  function isSquare(rect) {
    if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return false
    if (rect.width > MAX_SIZE || rect.height > MAX_SIZE) return false
    var ratio = rect.width / rect.height
    return ratio >= 0.8 && ratio <= 1.25
  }

  function isVisible(node) {
    // Ask the element's own window first: the login view may live in a frame,
    // and a WebView is not required to resolve styles across documents.
    var view = (node.ownerDocument && node.ownerDocument.defaultView) || window
    var style
    try {
      style = view.getComputedStyle(node)
    } catch (error) {
      try {
        style = window.getComputedStyle(node)
      } catch (ignored) {
        return true
      }
    }
    if (!style) return true
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
  }

  // The login view sits in the top document today, but the site has rendered it
  // in a same-origin frame before. Frames that cannot be read are skipped.
  function documents() {
    var list = [document]
    for (var index = 0; index < list.length && list.length < MAX_FRAMES; index++) {
      var frames
      try {
        frames = list[index].querySelectorAll('iframe')
      } catch (error) {
        continue
      }
      for (var frame = 0; frame < frames.length; frame++) {
        try {
          var child = frames[frame].contentDocument
          if (child && list.indexOf(child) < 0) list.push(child)
        } catch (error) {
          // Cross-origin frame: its scroll position is not ours to manage.
        }
      }
    }
    return list
  }

  function qrCanvas(doc) {
    var canvases
    try {
      canvases = doc.querySelectorAll('canvas')
    } catch (error) {
      return null
    }
    var best = null
    var bestArea = 0
    for (var index = 0; index < canvases.length; index++) {
      var canvas = canvases[index]
      var rect = rectOf(canvas)
      if (!rect || !isSquare(rect) || !isVisible(canvas)) continue
      var area = rect.width * rect.height
      if (area > bestArea) {
        best = canvas
        bestArea = area
      }
    }
    return best
  }

  function qrLabel(doc) {
    var nodes
    try {
      nodes = doc.querySelectorAll('div, span, p, strong')
    } catch (error) {
      return null
    }
    for (var index = 0; index < nodes.length; index++) {
      var node = nodes[index]
      // Only a node whose own text is the label, not a wrapper repeating it.
      if (node.childNodes.length !== 1 || node.childNodes[0].nodeType !== 3) continue
      if (!node.textContent || node.textContent.trim() !== LABEL) continue
      if (!isVisible(node)) continue
      return node
    }
    return null
  }

  function findQr(docs) {
    for (var index = 0; index < docs.length; index++) {
      var canvas = qrCanvas(docs[index])
      if (canvas) return canvas
    }
    for (var other = 0; other < docs.length; other++) {
      var label = qrLabel(docs[other])
      if (!label) continue
      // The QR follows the label inside the same login card.
      var card = label.parentElement
      if (!card) continue
      var rect = rectOf(card)
      if (rect) return card
    }
    return null
  }

  var docs = documents()
  for (var listening = 0; listening < docs.length; listening++) {
    listen(docs[listening].defaultView)
  }
  if (window.__bilimusicQrUserMoved) return

  var target = findQr(docs)
  if (!target) return
  var rect = rectOf(target)
  if (!rect) return

  var view = (target.ownerDocument && target.ownerDocument.defaultView) || window
  var width = view.innerWidth || window.innerWidth || 0
  var height = view.innerHeight || window.innerHeight || 0
  if (width <= 0 || height <= 0) return

  var fullyVisible = rect.top >= MARGIN && rect.left >= MARGIN &&
    rect.bottom <= height - MARGIN && rect.right <= width - MARGIN
  if (fullyVisible) return

  try {
    target.scrollIntoView({ block: 'center', inline: 'center' })
  } catch (error) {
    try { target.scrollIntoView() } catch (ignored) { /* not scrollable */ }
  }

  // A login card positioned with `fixed` ignores page scrolling. Only nudge the
  // window when the scroll left the QR completely outside the viewport, so a
  // partially visible (or already centred) QR is left alone.
  var after = rectOf(target)
  if (!after) return
  var offscreen = after.bottom <= 0 || after.right <= 0 || after.top >= height || after.left >= width
  if (!offscreen) return
  var deltaY = after.top + after.height / 2 - height / 2
  var deltaX = after.left + after.width / 2 - width / 2
  try {
    if (typeof view.scrollBy === 'function') view.scrollBy(deltaX, deltaY)
    else window.scrollBy(deltaX, deltaY)
  } catch (error) {
    // The page may be mid-navigation; the next poll tries again.
  }
})();
