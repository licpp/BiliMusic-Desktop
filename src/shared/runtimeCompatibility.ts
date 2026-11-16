// Vite lowers syntax, not built-in APIs. iOS 15.0–15.3 still run the app's
// supported WKWebView and lack these ES2022 methods. Install before app imports;
// modern WebViews keep their native implementation.
if (typeof Array.prototype.at !== 'function') {
  Object.defineProperty(Array.prototype, 'at', {
    configurable: true, writable: true,
    value: function at(this: unknown, index = 0) {
      if (this == null) throw new TypeError('Array.at requires an object')
      const object = Object(this) as ArrayLike<unknown>
      const length = Math.min(Math.max(Math.trunc(+object.length) || 0, 0), Number.MAX_SAFE_INTEGER)
      const relative = Math.trunc(+index) || 0
      const offset = relative < 0 ? length + relative : relative
      return offset < 0 || offset >= length ? undefined : object[offset]
    },
  })
}
if (typeof Object.hasOwn !== 'function') {
  Object.defineProperty(Object, 'hasOwn', {
    configurable: true, writable: true,
    value: (object: object, property: PropertyKey) => Object.prototype.hasOwnProperty.call(object, property),
  })
}
export {}
