// Player head rendering: fetch a player's skin through the panel's
// same-origin proxy (/skin-image/:uuid), then crop the 8x8 face region (plus
// the hat layer, which sits at 40,8 in the texture) onto a canvas and upscale
// it into the row's avatar box. Same-origin means the canvas is never tainted.
//
// Each avatar box needs its own <img> so failures fall back to the existing
// initial/placeholder glyph without disturbing other rows.

export function renderPlayerHead(img, uuid, { serverId } = {}) {
  if (!img || !uuid || !serverId) return;
  const url = `/api/servers/${serverId}/players/skin-image/${encodeURIComponent(uuid)}`;

  const image = new Image();
  image.onerror = () => {
    /* keep the placeholder glyph in the row */
  };
  image.onload = () => {
    try {
      const size = 8;
      const scale = img.clientWidth || 32; // fall back if laid out at 0
      const canvas = document.createElement('canvas');
      canvas.width = size * scale;
      canvas.height = size * scale;
      const ctx = canvas.getContext('2d');
      // Face layer (8,8)-(16,16), then the hat overlay (40,8)-(48,16) on top.
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, 8, 8, size, size, 0, 0, size * scale, size * scale);
      ctx.drawImage(image, 40, 8, size, size, 0, 0, size * scale, size * scale);
      img.src = canvas.toDataURL('image/png');
      img.classList.add('player-head');
    } catch {
      /* canvas may be unavailable - keep the placeholder */
    }
  };
  image.src = url;
}
