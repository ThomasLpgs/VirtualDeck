// Icon of a program (Spotify, OBS…) as a picture for the key that opens it.
// Windows gives Electron 32 px icons at most (app.getFileIcon), blurry on an 88 px key: the
// 256 px version is read from the program itself through PowerShell, with getFileIcon as fallback.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Paths go through environment variables, never through the command line (no quoting issues).
const EXTRACT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class VirtualDeckIcon {
  // Crops the transparent margins (often uneven: shadows, page curls) to a square centered on
  // what is drawn, so the icon sits in the middle of the key and fills it.
  public static Bitmap Trim(Bitmap source) {
    int width = source.Width, height = source.Height;
    BitmapData data = source.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    byte[] pixels = new byte[data.Stride * height];
    Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
    int stride = data.Stride;
    source.UnlockBits(data);
    int minX = width, minY = height, maxX = -1, maxY = -1;
    for (int y = 0; y < height; y++) {
      for (int x = 0; x < width; x++) {
        if (pixels[y * stride + x * 4 + 3] <= 16) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return source;
    int w = maxX - minX + 1, h = maxY - minY + 1, side = Math.Max(w, h);
    Bitmap result = new Bitmap(side, side, PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(result)) {
      g.Clear(Color.Transparent);
      g.DrawImage(source, new Rectangle((side - w) / 2, (side - h) / 2, w, h), new Rectangle(minX, minY, w, h), GraphicsUnit.Pixel);
    }
    return result;
  }

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern uint PrivateExtractIcons(string file, int index, int cx, int cy, IntPtr[] icons, uint[] ids, uint count, uint flags);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr icon);
}
'@
$handles = New-Object IntPtr[] 1
$ids = New-Object UInt32[] 1
$count = [VirtualDeckIcon]::PrivateExtractIcons($env:VD_ICON_FILE, [int]$env:VD_ICON_INDEX, 256, 256, $handles, $ids, 1, 0)
if ($count -lt 1 -or $handles[0] -eq [IntPtr]::Zero) { exit 2 }
try {
  $bitmap = [VirtualDeckIcon]::Trim([System.Drawing.Icon]::FromHandle($handles[0]).ToBitmap())
  $bitmap.Save($env:VD_ICON_OUT, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
} finally {
  [VirtualDeckIcon]::DestroyIcon($handles[0]) | Out-Null
}
`;
const EXTRACT_TIMEOUT_MS = 15 * 1000;
// Files whose icon is inside them; for others (documents, folders) Windows' icon is used.
const ICON_FILES = /\.(exe|dll|ico)$/i;

function extractLargeIcon(file, index, out) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', EXTRACT_SCRIPT],
      { env: { ...process.env, VD_ICON_FILE: file, VD_ICON_INDEX: String(index), VD_ICON_OUT: out }, timeout: EXTRACT_TIMEOUT_MS, windowsHide: true },
      (err) => resolve(!err && fs.existsSync(out)),
    );
  });
}

// target: what the key opens (a program, shortcut, document or folder).
// electron: { app, shell } (passed in, so this file has no Electron dependency of its own).
// Returns the path of the saved PNG, or '' when there is no icon to take.
async function saveAppIcon(target, dir, { app, shell }) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || !fs.existsSync(target)) return '';
  // A shortcut (.lnk, like the Start menu ones): the icon it shows, else the program it opens.
  let file = target;
  let index = 0;
  if (/\.lnk$/i.test(target)) {
    try {
      const link = shell.readShortcutLink(target);
      file = link.icon || link.target || target;
      index = link.icon ? link.iconIndex || 0 : 0;
    } catch {
      // Unreadable shortcut: Windows' own icon for it below.
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  const work = path.join(dir, `app-${crypto.randomBytes(8).toString('hex')}.tmp.png`);
  if (!(ICON_FILES.test(file) && fs.existsSync(file) && (await extractLargeIcon(file, index, work)))) {
    const icon = await app.getFileIcon(target, { size: 'large' });
    if (icon.isEmpty()) {
      fs.rmSync(work, { force: true });
      return '';
    }
    fs.writeFileSync(work, icon.toPNG());
  }
  return keepByContent(work, dir);
}

// Named after its content: a new picture never reuses the name (and the cached image) of an old
// one, and the same icon taken twice is stored once.
function keepByContent(work, dir) {
  const hash = crypto.createHash('sha1').update(fs.readFileSync(work)).digest('hex').slice(0, 16);
  const out = path.join(dir, `app-${hash}.png`);
  if (fs.existsSync(out)) fs.rmSync(work);
  else fs.renameSync(work, out);
  return out;
}

module.exports = { saveAppIcon };
