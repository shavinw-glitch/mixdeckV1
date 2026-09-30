/* =========================================================================
   Mixdeck metadata engine — the single place that turns a music file (or
   its bytes) into identity: title, artist, album, cover…

   Everything here is pure, dependency-free and runs 100 % on the device.
   It reads tags at the byte level (ID3v2/ID3v1, MP4 iTunes atoms, FLAC
   Vorbis comments + pictures), and where a file carries no readable tags it
   falls back to careful filename parsing. Nothing in this module touches the
   network or the DOM, which is what makes it testable in Node and reliable
   on phones.
   ========================================================================= */

function decStr(bytes, label) { try { return new TextDecoder(label).decode(bytes); } catch { return ''; } }
function be32(u8, i) { return (u8[i] * 0x1000000) + (u8[i + 1] << 16) + (u8[i + 2] << 8) + u8[i + 3]; }
function le32(u8, i) { return u8[i] + (u8[i + 1] << 8) + (u8[i + 2] << 16) + (u8[i + 3] * 0x1000000); }
function syncsafe(u8, i) { return ((u8[i] & 0x7f) << 21) | ((u8[i + 1] & 0x7f) << 14) | ((u8[i + 2] & 0x7f) << 7) | (u8[i + 3] & 0x7f); }
function cleanText(s) { return String(s || '').replace(/^\u0000+|\u0000+$/g, '').replace(/\u0000/g, '').trim(); }

/* --------------------------- display helpers ---------------------------- */
export function fileTitle(name) {
  return (String(name || '').replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled track');
}

/** Split a filename into a guessed { artist, title }. Accepts real-world
 *  naming: leading track numbers, unicode dashes, [bracketed] prefixes and
 *  trailing "(Edit)" / "[Explicit]" style tags. Never guesses an artist when
 *  the pattern is not confidently "Performer - Song". */
export function filenameMetadata(name) {
  const raw = String(name || '').replace(/\.[^/.]+$/, '').trim();
  // Strip leading track numbers: "01 - Artist - Song", "3. Artist – Song"
  const stem = raw.replace(/^\s*\d{1,3}\s*[.)\-–—]\s*/, '').trim();
  const match = stem.match(/^(.+?)\s+[-–—~|]\s+(.+)$/);
  if (!match) return { artist: '', title: stem || fileTitle(name) };
  // Drop bracketed/parenthesised prefixes ("[Mix] Some DJ - Track") and stray edge brackets
  const artist = match[1].trim()
    .replace(/^\s*\[[^\]]*\]\s*/, '')
    .replace(/^\s*\([^)]*\)\s*/, '')
    .replace(/^[\[\]()\s]+|[\[\]()\s]+$/g, '')
    .trim();
  // Drop trailing version/annotation tags like "(Edit)", "[Explicit]"
  const title = match[2].trim()
    .replace(/\s+[\[\(][^\]\)]*[\]\)]\s*$/, '')
    .trim();
  return { artist, title };
}

export function guessArtist(title) {
  const t = String(title || '');
  const m = t.match(/\s+[-–—~|]\s+/);
  const raw = m ? t.slice(0, m.index).trim() : '';
  return raw || 'Unknown artist';
}

/** True when a tag value is a placeholder (compilation marker, uploader
 *  handle, "Unknown", a URL…) rather than a real performer. */
export function isJunkArtist(value) {
  const v = String(value || '').replace(/\u0000/g, '').trim();
  if (!v) return true;
  if (v === 'Unknown' || v === 'Unknown artist') return true;
  if (/^(various|various\s*artists|va|uncredited|unknown|track|artist|soundtrack|composer|none|null|\?|mixed\s*by|dj)$/i.test(v)) return true;
  if (/^(https?:|www\.)|youtube|youtu\.be|@|(feat\.?|ft\.?)\s*$|^\s*[-–—~|]\s*$/i.test(v)) return true;
  if (v === v.toLowerCase() && /^[a-z0-9 _-]{0,40}$/i.test(v) && !/[A-Z]/.test(v) && /\s/.test(v) && v.split(' ').length > 4) return true;
  return false;
}

/** Return a credible artist out of a combined/featured string — used when
 *  matching tags against a library or online result. Keeps the first
 *  performer, joined-list separators are the common tag encodings. */
export function primaryArtist(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  const parts = v.split(/\s*[;/,&]\s*|\s+(?:feat\.?|ft\.?|featuring|with)\s+/i);
  for (const part of parts) {
    const candidate = part.trim();
    if (candidate && !isJunkArtist(candidate)) return candidate;
  }
  return v.split(/\s*[;/,&]\s*|\s+(?:feat\.?|ft\.?|featuring|with)\s+/i)[0].trim();
}

/* --------------------------- comparison helpers -------------------------- */
export function normCompare(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
export function nameTokens(value) {
  const norm = normCompare(value);
  const tokens = norm ? norm.split(' ') : [];
  return tokens.filter(w => w.length > 1 || /^\d+$/.test(w));
}
export function tokenOverlap(a, b) {
  const A = a || [], B = b || [];
  if (!A.length || !B.length) return 0;
  const setB = new Set(B);
  const hit = A.filter(w => setB.has(w)).length;
  const union = new Set([...A, ...B]).size;
  return union ? hit / union : 0;
}

/** Strip trailing "[remaster]" / "(Official Audio)" style clutter before
 *  querying lyric or artwork services. Takes the raw title string. */
export function cleanTitleString(value) {
  return String(value || '')
    .replace(/\s*\[[^\]]+\]\s*$/g, '')
    .replace(/\s*\([^)]*(?:official|lyrics|audio|video|mv|hd|4k)[^)]*\)\s*$/ig, '')
    .trim();
}

/** A title that is really just the file name (tag-less downloads) is a
 *  low-confidence identity — used to decide when a lookup is worth doing. */
export function isRawFileNameTitle(title, fileName) {
  const t = normCompare(title);
  const f = normCompare(fileName);
  if (!t || !f) return false;
  return t === f || f.includes(t) && f.length - t.length <= 8;
}

/* ============================== tag readers ============================== */

function tagText(buf) {
  if (!buf || !buf.length) return '';
  const enc = buf[0]; const body = buf.subarray(1);
  if (enc === 3) return cleanText(decStr(body, 'utf-8'));
  if (enc === 2) return cleanText(decStr(body, 'utf-16be'));
  if (enc === 1) return cleanText(decStr(body, 'utf-16le'));
  return cleanText(decStr(body, 'windows-1252'));
}
function tagTrackNo(value) {
  const m = String(value || '').match(/\d+/);
  return m ? parseInt(m[0], 10) || 0 : 0;
}
function tagYear(value) {
  const m = String(value || '').match(/(19|20)\d{2}/);
  return m ? parseInt(m[0], 10) || 0 : 0;
}

export function parseID3v1(u8) {
  if (!u8 || u8.length < 128) return null;
  const o = u8.length - 128;
  if (decStr(u8.subarray(o, o + 3), 'ascii') !== 'TAG') return null;
  const res = {
    title: cleanText(decStr(u8.subarray(o + 3, o + 33), 'windows-1252')),
    artist: cleanText(decStr(u8.subarray(o + 33, o + 63), 'windows-1252')),
    album: cleanText(decStr(u8.subarray(o + 63, o + 93), 'windows-1252')),
    albumArtist: '', genre: '', composer: '',
    year: tagYear(cleanText(decStr(u8.subarray(o + 93, o + 97), 'ascii'))),
    trackNumber: (u8[o + 125] === 0 && u8[o + 126]) ? u8[o + 126] : 0,
    artwork: null,
  };
  return res;
}

export function parseID3v2(u8) {
  if (!u8 || u8.length < 10 || u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return null;
  const ver = u8[3];
  if (ver !== 2 && ver !== 3 && ver !== 4) return null;
  const end = Math.min(u8.length, 10 + syncsafe(u8, 6));
  const canon = { TT2: 'TIT2', TP1: 'TPE1', TAL: 'TALB', TP2: 'TPE2', TCO: 'TCON', TYE: 'TYER', TRK: 'TRCK', TCM: 'TCOM' };
  const tags = {};
  let o = 10;
  while (o + 6 < end) {
    let fid, dStart, size;
    if (ver === 2) {
      fid = String.fromCharCode(u8[o], u8[o + 1], u8[o + 2]);
      size = (u8[o + 3] << 16) | (u8[o + 4] << 8) | u8[o + 5];
      dStart = o + 6;
    } else {
      fid = String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
      size = ver === 4 ? syncsafe(u8, o + 4) : be32(u8, o + 4);
      dStart = o + 10;
    }
    if (!fid || fid.charCodeAt(0) === 0) break;
    if (size <= 0) { o += ver === 2 ? 6 : 10; continue; }
    const dEnd = Math.min(end, dStart + size);
    const key = canon[fid] || fid;
    try {
      if (key[0] === 'T' && key !== 'TXXX') {
        // v2.3 stores the recording year in TYER; v2.4 in TDRC. Both land here.
        const val = tagText(u8.subarray(dStart, dEnd));
        if (val) tags[key] = val;
      } else if (key === 'APIC' && u8[dStart] === 0) {
        let m = dStart + 1;
        while (m < dEnd && u8[m] !== 0) m++;
        const mime = cleanText(decStr(u8.subarray(dStart + 1, m), 'windows-1252'));
        let s = m + 2;
        while (s < dEnd && u8[s] !== 0) s++;
        s++;
        if (s < dEnd) {
          const data = u8.slice(s, dEnd);
          tags.artwork = { data, mime: mime || (data[0] === 0xff ? 'image/jpeg' : 'image/png') };
        }
      }
    } catch { /* malformed frame — skip */ }
    o = dEnd;
  }
  return {
    title: tags.TIT2 || '', artist: tags.TPE1 || '', album: tags.TALB || '',
    albumArtist: tags.TPE2 || '', genre: tags.TCON || '', composer: tags.TCOM || '',
    year: tagYear(tags.TDRC || tags.TYER),
    trackNumber: tagTrackNo(tags.TRCK),
    artwork: tags.artwork || null,
  };
}

export function parseFLAC(u8) {
  if (!u8 || u8.length < 8 || decStr(u8.subarray(0, 4), 'ascii') !== 'fLaC') return null;
  const kv = {};
  let art = null;
  let o = 4;
  while (o + 4 <= u8.length) {
    const hdr = be32(u8, o);
    const last = (hdr & 0x80000000) !== 0;
    const type = (hdr >>> 24) & 0x7f;
    const size = hdr & 0xffffff;
    const dStart = o + 4, dEnd = Math.min(u8.length, dStart + size);
    if (type === 4) { // Vorbis comment
      let p = dStart;
      if (p + 4 > dEnd) break;
      const vendorLen = le32(u8, p); p += 4;
      p += vendorLen;
      if (p + 4 > dEnd) break;
      let count = le32(u8, p); p += 4;
      while (count-- > 0 && p + 4 <= dEnd) {
        const len = le32(u8, p); p += 4;
        if (p + len > dEnd) break;
        const line = decStr(u8.subarray(p, p + len), 'utf-8');
        p += len;
        const eq = line.indexOf('=');
        if (eq > 0) kv[line.slice(0, eq).toUpperCase()] = line.slice(eq + 1);
      }
    } else if (type === 6 && !art) { // Picture block (FLAC standard picture)
      try {
        // FLAC picture fields are BIG-endian (unlike Vorbis comments above,
        // which stay little-endian per the Vorbis comment spec).
        let p = dStart + 4; // skip picture type
        const mimeLen = be32(u8, p); p += 4;
        const mime = cleanText(decStr(u8.subarray(p, p + mimeLen), 'windows-1252')); p += mimeLen;
        const descLen = be32(u8, p); p += 4 + descLen;
        p += 16; // width, height, depth, colors
        if (p + 4 <= dEnd) {
          const dataLen = be32(u8, p); p += 4;
          if (dataLen > 0 && p + dataLen <= dEnd) {
            const data = u8.slice(p, p + dataLen);
            art = { data, mime: mime || (data[0] === 0xff && data[1] === 0xd8 ? 'image/jpeg' : 'image/png') };
          }
        }
      } catch { /* ignore picture block */ }
    }
    if (last) break;
    o = dEnd;
  }
  return {
    title: kv.TITLE || '', artist: kv.ARTIST || '', album: kv.ALBUM || '',
    albumArtist: kv.ALBUMARTIST || kv.ALBUM_ARTIST || '',
    genre: kv.GENRE || '', composer: kv.COMPOSER || '',
    year: tagYear(kv.DATE || kv.YEAR), trackNumber: tagTrackNo(kv.TRACKNUMBER || kv.TRACK),
    artwork: art,
  };
}

export function parseMP4(u8) {
  if (!u8 || u8.length < 12 || decStr(u8.subarray(4, 8), 'ascii') !== 'ftyp') return null;
  const tags = {};
  let art = null;
  function fourcc(o) { return String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]); }
  function findIlst(start, end) {
    let o = start;
    while (o + 8 <= end) {
      const sz = be32(u8, o);
      const type = fourcc(o + 4);
      const childStart = o + 8 + (type === 'meta' ? 4 : 0);
      let childEnd = sz === 1 ? end : (sz === 0 ? end : Math.min(end, o + sz));
      if (type === 'ilst') return { start: childStart, end: childEnd };
      if (type === 'moov' || type === 'udta' || type === 'meta') {
        const sub = findIlst(childStart, childEnd);
        if (sub) return sub;
      }
      if (childEnd <= o) break;
      o = childEnd;
    }
    return null;
  }
  const ilst = findIlst(0, u8.length);
  if (!ilst) return null;
  const nameMap = { '©nam': 'TIT2', '©ART': 'TPE1', aART: 'TPE2', '©alb': 'TALB', '©gen': 'TCON', '©day': 'TDRC', '©wrt': 'TCOM' };
  let o = ilst.start;
  while (o + 8 <= ilst.end) {
    const itemSz = be32(u8, o);
    const name = fourcc(o + 4);
    let itemEnd = itemSz === 1 ? ilst.end : (itemSz === 0 ? ilst.end : Math.min(ilst.end, o + itemSz));
    let p = o + 8;
    while (p + 8 <= itemEnd) {
      const dSz = be32(u8, p);
      const dType = fourcc(p + 4);
      const dEnd = dSz === 0 ? itemEnd : Math.min(itemEnd, p + dSz);
      if (dType === 'data') {
        const payload = u8.subarray(p + 16, dEnd);
        try {
          if (name === 'covr') {
            if (!art && payload.length) art = { data: payload, mime: (payload[0] === 0xff && payload[1] === 0xd8) ? 'image/jpeg' : 'image/png' };
          } else if (name === 'trkn' && payload.length >= 6) {
            // Some encoders store [reserved][track][total], others put a
            // 4-byte locale first — try both offsets.
            let no = (payload[2] << 8) | payload[3];
            if (!no && payload.length >= 10) no = (payload[6] << 8) | payload[7];
            if (no) tags.TRCK = String(no);
          } else {
            const key = nameMap[name];
            if (key) {
              const val = cleanText(decStr(payload, 'utf-8'));
              if (val && !tags[key]) tags[key] = val;
            }
          }
        } catch { /* skip item */ }
      }
      if (dEnd <= p) break;
      p = dEnd;
    }
    if (itemEnd <= o) break;
    o = itemEnd;
  }
  return {
    title: tags.TIT2 || '', artist: tags.TPE1 || '', album: tags.TALB || '',
    albumArtist: tags.TPE2 || '', genre: tags.TCON || '', composer: tags.TCOM || '',
    year: tagYear(tags.TDRC), trackNumber: tagTrackNo(tags.TRCK),
    artwork: art,
  };
}

/** Try every tag layout we know against a full byte buffer. Returns the
 *  first structured result, or null when the file carries no readable tags
 *  of a supported format. */
export function parseLocalTags(u8) {
  if (!u8 || !u8.length) return null;
  let res = null;
  if (u8.length >= 3 && u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) res = parseID3v2(u8);
  else if (u8.length >= 12) {
    if (decStr(u8.subarray(4, 8), 'ascii') === 'ftyp') res = parseMP4(u8);
    else if (decStr(u8.subarray(0, 4), 'ascii') === 'fLaC') res = parseFLAC(u8);
  }
  if (!res || !(res.title || res.artist || res.album || res.artwork)) res = parseID3v1(u8);
  return res;
}

/** Which tag container the bytes start with — used to describe how a track
 *  was identified (nice for debugging + the Edit-details sheet). */
export function sniffFormat(u8) {
  if (!u8 || u8.length < 4) return 'unknown';
  if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) return 'mp3';
  if (decStr(u8.subarray(0, 4), 'ascii') === 'fLaC') return 'flac';
  if (u8.length >= 12 && decStr(u8.subarray(4, 8), 'ascii') === 'ftyp') return 'mp4';
  if (decStr(u8.subarray(0, 4), 'ascii') === 'OggS') return 'ogg';
  if (decStr(u8.subarray(0, 4), 'ascii') === 'RIFF') return 'wav';
  return 'unknown';
}

/** Master byte-level identification. Callers that only have the file head
 *  can pass the whole head buffer — for reliable results pass the complete
 *  file bytes (the app stores them anyway). Returns:
 *    { title, artist, album, albumArtist, genre, composer, year,
 *      trackNumber, artwork: {data:Uint8Array,mime}|null, format }  */
export function identifyFromBytes(u8) {
  const parsed = parseLocalTags(u8);
  const empty = {
    title: '', artist: '', album: '', albumArtist: '', genre: '', composer: '',
    year: 0, trackNumber: 0, artwork: null, format: sniffFormat(u8),
  };
  if (!parsed) return empty;
  return {
    title: parsed.title || '',
    artist: parsed.artist || '',
    album: parsed.album || '',
    albumArtist: parsed.albumArtist || '',
    genre: parsed.genre || '',
    composer: parsed.composer || '',
    year: Number(parsed.year) || 0,
    trackNumber: Number(parsed.trackNumber) || 0,
    artwork: parsed.artwork || null,
    format: sniffFormat(u8),
  };
}
