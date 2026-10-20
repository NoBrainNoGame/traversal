import "@ghom/booyah"

// @ghom/utils (pulled in by booyah) adds enumerable methods to built-in prototypes,
// which leak into `for...in` loops such as Pixi's renderer setup. Hide them.
for (const proto of [Array.prototype, Object.prototype, String.prototype, Number.prototype, RegExp.prototype, Function.prototype]) {
  for (const key of Object.keys(proto)) {
    Object.defineProperty(proto, key, { enumerable: false })
  }
}
