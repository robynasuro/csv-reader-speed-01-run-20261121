// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
// Same answers on every input, less CPU time: bulk line and field scanning
// instead of one character at a time. No dependencies, no state kept between
// calls: run(input) is pure, exactly like the reference.

// Terminator scan for unquoted fields: the first of comma, CR, LF.
const TERM = /[,\r\n]/g;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const len = text.length;
  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and its index in rows (null: header).
  let recordLine = 1;
  let recordRow = null;

  // Reads an unquoted field starting at pos, with `value` already collected.
  // Returns { value, ended, added }: ended is 'comma' | 'break' | 'end', and
  // added counts the characters appended here. A CR not followed by LF is
  // dropped (stray_cr); the record's other errors keep their order.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      TERM.lastIndex = pos;
      const m = TERM.exec(text);
      if (m === null) {
        if (pos < len) {
          value += text.slice(pos);
          added += len - pos;
          pos = len;
        }
        return { value, ended: 'end', added };
      }
      const i = m.index;
      const ch = m[0];
      if (i > pos) {
        value += text.slice(pos, i);
        added += i - pos;
      }
      if (ch === ',') {
        pos = i + 1;
        return { value, ended: 'comma', added };
      }
      if (ch === '\n') {
        pos = i + 1;
        line += 1;
        return { value, ended: 'break', added };
      }
      // A CR: a line break when followed by LF, else a dropped stray CR.
      if (text[i + 1] === '\n') {
        pos = i + 2;
        line += 1;
        return { value, ended: 'break', added };
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos = i + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let p = pos + 1;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      if (q > p) {
        const seg = text.slice(p, q);
        if (seg.indexOf('\r') === -1 && seg.indexOf('\n') === -1) {
          value += seg;
        } else {
          // Each CRLF or lone CR inside quotes is one LF, and counts one line.
          const norm = seg.replace(/\r\n?/g, '\n');
          let n = 0;
          let k = -1;
          for (;;) {
            k = norm.indexOf('\n', k + 1);
            if (k === -1) break;
            n += 1;
          }
          line += n;
          value += norm;
        }
      }
      if (text[q + 1] === '"') {
        value += '"';
        p = q + 2;
        continue;
      }
      pos = q + 1;
      if (pos >= len) return { value, ended: 'end' };
      const c = text[pos];
      if (c === ',') {
        pos += 1;
        return { value, ended: 'comma' };
      }
      if (c === '\n') {
        pos += 1;
        line += 1;
        return { value, ended: 'break' };
      }
      if (c === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
        return { value, ended: 'break' };
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      const junk = readUnquoted(value);
      if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return junk;
    }
  }

  // Finishes a record's fields: header, width, short/long rows. Returns false
  // when the record is no record (a line left with no characters).
  function finishRecord(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return false;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return false;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
    return true;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text[pos];
      if (c === '\n') {
        pos += 1;
        line += 1;
      } else if (c === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a whole line with no quotes and no CR (other than a CRLF
    // ending) splits on commas as it stands.
    const nl = text.indexOf('\n', pos);
    const rawEnd = nl === -1 ? len : nl;
    let lineEnd = rawEnd;
    if (nl !== -1 && lineEnd > pos && text[lineEnd - 1] === '\r') lineEnd -= 1;
    const lineText = text.slice(pos, lineEnd);
    if (lineText.indexOf('"') === -1 && lineText.indexOf('\r') === -1) {
      const fields = lineText.split(',');
      pos = nl === -1 ? len : nl + 1;
      if (nl !== -1) line += 1;
      finishRecord(fields, false);
      continue;
    }

    const fields = [];
    let field;
    let quoted = false;
    do {
      quoted = text[pos] === '"';
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === 'comma');
    finishRecord(fields, quoted);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
