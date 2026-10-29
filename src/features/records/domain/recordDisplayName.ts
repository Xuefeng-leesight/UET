function sanitizeSubjectLikeRecorder(name: string): string {
  const out: string[] = [];
  for (const ch of name) {
    if (ch.charCodeAt(0) < 128 && /[A-Za-z0-9_-]/.test(ch)) {
      out.push(ch);
    } else {
      out.push('_');
    }
  }
  return out.join('') || 'subject';
}

export function getDisplayRecordName(record: { name?: unknown; subjectName?: unknown }): string {
  const rawName = typeof record?.name === 'string' ? record.name.trim() : '';
  const subjectName = typeof record?.subjectName === 'string' ? record.subjectName.trim() : '';

  if (!rawName) return subjectName || '—';

  // When filename was sanitized (e.g. Chinese subject name on Windows recorder),
  // show a user-friendly display name composed from subject name + timestamp suffix.
  const match = /^(.+?)_(\d{8}_\d{6})$/.exec(rawName);
  if (match && subjectName) {
    const prefix = match[1];
    const ts = match[2];
    const safeSubject = sanitizeSubjectLikeRecorder(subjectName);
    if (prefix === safeSubject || /^_+\d*$/.test(prefix)) {
      return `${subjectName}_${ts}`;
    }
  }

  if (/^_+$/.test(rawName) && subjectName) {
    return subjectName;
  }

  return rawName;
}
