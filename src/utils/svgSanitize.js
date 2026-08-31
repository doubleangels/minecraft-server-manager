'use strict';

const sanitizeHtml = require('sanitize-html');

// Uploaded avatars/server icons are served under a locked-down sandbox CSP +
// nosniff, which already stops an embedded <script> from running when the file
// is opened directly. This is the defence-in-depth layer behind that: scrub the
// SVG at rest so a hostile file never lands on disk in the first place (a proxy
// that strips the response headers, or a future direct <object>/<iframe> embed,
// would otherwise turn it into stored XSS). The official uploader rasterises SVG
// to PNG client-side, so in practice this only runs for direct API callers.

// A conservative drawing-only subset. htmlparser2 lowercases names, so every
// tag/attr here is lowercase; some camelCase SVG features (viewBox, gradients)
// round-trip case-folded but still render, and a mangled edge-case SVG is an
// acceptable outcome for this rarely-hit path.
const ALLOWED_TAGS = [
  'svg',
  'g',
  'defs',
  'title',
  'desc',
  'symbol',
  'use',
  'switch',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textpath',
  'lineargradient',
  'radialgradient',
  'stop',
  'pattern',
  'clippath',
  'mask',
  'marker',
  'filter',
  'fegaussianblur',
  'feoffset',
  'feblend',
  'fecolormatrix',
  'femerge',
  'femergenode',
  'fecomposite',
  'feflood',
  'femorphology',
  'fetile',
];

const ALLOWED_ATTRS = [
  'id',
  'class',
  'style',
  'transform',
  'xmlns',
  'xmlns:xlink',
  'version',
  'width',
  'height',
  'viewbox',
  'preserveaspectratio',
  'd',
  'points',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'dx',
  'dy',
  'offset',
  'gradientunits',
  'gradienttransform',
  'spreadmethod',
  'patternunits',
  'patterntransform',
  'patterncontentunits',
  'markerwidth',
  'markerheight',
  'markerunits',
  'orient',
  'refx',
  'refy',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'stroke-miterlimit',
  'opacity',
  'color',
  'stop-color',
  'stop-opacity',
  'clip-path',
  'clip-rule',
  'mask',
  'filter',
  'text-anchor',
  'dominant-baseline',
  'alignment-baseline',
  'font-size',
  'font-family',
  'font-weight',
  'font-style',
  'letter-spacing',
  'word-spacing',
  'result',
  'in',
  'in2',
  'stddeviation',
  'mode',
  'type',
  'values',
  'operator',
  'k1',
  'k2',
  'k3',
  'k4',
  'flood-color',
  'flood-opacity',
  'radius',
];

/**
 * Strip scripting and external references from an SVG string, keeping only
 * inert drawing markup. `<script>`, `<foreignObject>`, event handlers, and any
 * href/src (no javascript:, no data:, no remote fetch) are all dropped.
 */
function sanitizeSvg(input) {
  return sanitizeHtml(String(input || ''), {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { '*': ALLOWED_ATTRS },
    // No href/xlink:href at all - removes javascript: URLs, data: URLs and
    // remote <use>/<image> references in one move.
    allowedSchemes: [],
    allowedSchemesAppliedToAttributes: [],
    allowProtocolRelative: false,
    parser: { lowerCaseTags: true, lowerCaseAttributeNames: true },
    disallowedTagsMode: 'discard',
  });
}

module.exports = { sanitizeSvg };
