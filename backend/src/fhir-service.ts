/**
 * Builds a standard FHIR R4 Bundle from a completed intake session so it can be
 * ingested by a hospital EMR/HIS. Produces Patient, Encounter,
 * QuestionnaireResponse (the captured Q&A), Flag (red flags) and a
 * DocumentReference (the clinician report).
 *
 * Pushing the bundle to a specific EMR's FHIR endpoint is a thin transport layer
 * the hospital configures (FHIR base URL + auth) — kept out of this generator.
 */

interface SessionLike {
  id: string;
  patient_name?: string;
  start_time?: any;
  end_time?: any;
  status?: string;
}
interface IntakeLike { question?: string; answer?: string; category?: string }
interface RedFlagLike { symptoms?: string; severity?: string; timestamp?: any }
interface ReportLike { report_content?: string; status?: string; reviewed_by?: string | null }

const iso = (v: any): string | undefined => {
  if (!v) return undefined;
  try { return new Date(v).toISOString(); } catch { return undefined; }
};

export function buildFhirBundle(
  session: SessionLike,
  intake: IntakeLike[] = [],
  redFlags: RedFlagLike[] = [],
  report: ReportLike | null = null
): any {
  const sid = session.id;
  const patientRef = `Patient/patient-${sid}`;
  const encounterRef = `Encounter/encounter-${sid}`;

  const entries: any[] = [];

  // Patient
  entries.push({
    fullUrl: `urn:uuid:patient-${sid}`,
    resource: {
      resourceType: 'Patient',
      id: `patient-${sid}`,
      name: session.patient_name ? [{ text: session.patient_name }] : undefined,
    },
  });

  // Encounter (the pre-consultation intake)
  entries.push({
    fullUrl: `urn:uuid:encounter-${sid}`,
    resource: {
      resourceType: 'Encounter',
      id: `encounter-${sid}`,
      status: session.status === 'completed' ? 'finished' : 'in-progress',
      class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
      type: [{ text: 'AI pre-consultation intake' }],
      subject: { reference: patientRef },
      period: { start: iso(session.start_time), end: iso(session.end_time) },
    },
  });

  // QuestionnaireResponse — the captured intake Q&A
  entries.push({
    fullUrl: `urn:uuid:qr-${sid}`,
    resource: {
      resourceType: 'QuestionnaireResponse',
      id: `qr-${sid}`,
      status: 'completed',
      subject: { reference: patientRef },
      encounter: { reference: encounterRef },
      authored: iso(session.end_time) || iso(session.start_time),
      item: intake.map((r, i) => ({
        linkId: String(i + 1),
        text: r.question || '',
        answer: [{ valueString: r.answer || '' }],
      })),
    },
  });

  // Flags — clinical red flags detected during intake
  redFlags.forEach((rf, i) => {
    entries.push({
      fullUrl: `urn:uuid:flag-${sid}-${i}`,
      resource: {
        resourceType: 'Flag',
        id: `flag-${sid}-${i}`,
        status: 'active',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/flag-category', code: 'clinical', display: 'Clinical' }] }],
        code: { text: `Red flag (${rf.severity || 'unknown'}): ${rf.symptoms || ''}` },
        subject: { reference: patientRef },
        encounter: { reference: encounterRef },
        period: { start: iso(rf.timestamp) },
      },
    });
  });

  // DocumentReference — the generated clinician report
  if (report?.report_content) {
    entries.push({
      fullUrl: `urn:uuid:doc-${sid}`,
      resource: {
        resourceType: 'DocumentReference',
        id: `doc-${sid}`,
        status: 'current',
        docStatus: report.status === 'approved' ? 'final' : 'preliminary',
        type: { text: 'Pre-consultation intake report' },
        subject: { reference: patientRef },
        context: { encounter: [{ reference: encounterRef }] },
        author: report.reviewed_by ? [{ display: report.reviewed_by }] : undefined,
        content: [{
          attachment: {
            contentType: 'text/plain',
            data: Buffer.from(report.report_content, 'utf8').toString('base64'),
          },
        }],
      },
    });
  }

  return {
    resourceType: 'Bundle',
    type: 'collection',
    timestamp: new Date().toISOString(),
    entry: entries,
  };
}
