/**
 * Shared intake-session bootstrap.
 * =====================================================================================
 * `createIntakeSession` is the single, authoritative path for starting a voice intake —
 * used by BOTH the staff endpoint (`POST /api/sessions/start`) and the public patient-link
 * endpoint (`POST /api/public/intake/:token/start`). Keeping one implementation guarantees
 * the two flows can never drift (same provider selection, key validation, patient resolve,
 * session creation, consent + audit logging, and realtime-pipeline init).
 *
 * On any failure it throws an `IntakeSessionError(httpStatus, payload)` so each caller maps
 * it to the right HTTP response. Behaviour is identical to the original inline handler; the
 * only change is awaiting the realtime init instead of using `.then()/.catch()`.
 */
import db from './database-manager.js';
import realtimeManager from './realtime.js';
import ProviderFactory from './providers/ProviderFactory.js';
import { MEDICAL_INTAKE_INSTRUCTIONS } from './constants.js';

/** Tolerantly parse the settings.engine_map JSON into the per-language map the Sarvam pipeline
 *  reads. Returns undefined on null/bad JSON so the provider falls back to its env defaults. */
function parseEngineMapSetting(raw: string | null | undefined): Record<string, { stt?: string; llm?: string; tts?: string }> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export class IntakeSessionError extends Error {
  httpStatus: number;
  payload: any;
  constructor(httpStatus: number, payload: any) {
    super(payload?.message || payload?.error || 'Failed to start session');
    this.name = 'IntakeSessionError';
    this.httpStatus = httpStatus;
    this.payload = payload;
  }
}

export interface CreateIntakeSessionOptions {
  patientName?: string;
  consentGiven: boolean;
  language?: string;
  phone?: string;
  source?: 'staff' | 'remote-link';
  ip?: string | null;
  userAgent?: string | null;
}

export interface CreateIntakeSessionResult {
  sessionId: string;
  provider: string;
  isReturning: boolean;
  patient: { name: string | null; visitCount: number; hasHistory: boolean } | null;
  status: string;
}

export async function createIntakeSession(opts: CreateIntakeSessionOptions): Promise<CreateIntakeSessionResult> {
  const { patientName, consentGiven, language, phone, source = 'staff', ip = null, userAgent = null } = opts;

  // Patient-chosen language for the Sarvam pipeline (te-IN default; hi-IN / en-IN supported).
  const sessionLanguage = ['te-IN', 'hi-IN', 'en-IN'].includes(language as any) ? (language as string) : 'te-IN';

  // Name is collected by VOICE during onboarding — no typed name is required. Start with a
  // placeholder; the agent writes the spoken name onto the session once the patient says it.
  const sessionPatientName = (patientName && patientName.trim().length > 0)
    ? patientName.trim()
    : 'New patient (voice)';

  // Patient consent is required before any PHI is collected.
  if (consentGiven !== true) {
    throw new IntakeSessionError(400, {
      error: 'Consent required',
      message: 'Patient consent is required before starting the intake.'
    });
  }

  // Get current settings from database
  const settings = await db.getAllSettings();
  const setting = settings && settings.length > 0 ? settings[0] : null;

  // Set the provider based on database settings
  const providerType = setting?.provider || 'openai';
  realtimeManager.setProvider(ProviderFactory.getProvider(providerType as any));
  console.log(`Using provider: ${providerType} (source=${source})`);

  // Validate API keys based on selected provider
  if (providerType === 'openai') {
    if (!(setting?.openai_api_key || process.env.OPENAI_API_KEY)) {
      throw new IntakeSessionError(400, {
        error: 'OpenAI API key missing',
        message: 'OpenAI API key not configured. Please check your Settings page or .env file.'
      });
    }
  } else if (providerType === 'retellai') {
    const retellApiKey = (setting as any)?.retellai_api_key || process.env.RETELLAI_API_KEY;
    const retellAgentId = (setting as any)?.retellai_agent_id || process.env.RETELLAI_AGENT_ID;
    if (!(retellApiKey && retellAgentId)) {
      throw new IntakeSessionError(400, {
        error: 'RetellAI configuration missing',
        message: 'RetellAI API key and Agent ID must be configured. Please check your Settings page or .env file.'
      });
    }
  } else if (providerType === 'sarvam') {
    if (!(setting?.openai_api_key || process.env.SARVAM_API_KEY)) {
      throw new IntakeSessionError(400, {
        error: 'Sarvam API key missing',
        message: 'Sarvam API subscription key not configured. Set SARVAM_API_KEY in .env or your Settings page.'
      });
    }
  } else if (providerType === 'vapi') {
    throw new IntakeSessionError(400, {
      error: 'VAPI not supported yet',
      message: 'VAPI integration is planned but not yet implemented.'
    });
  } else {
    throw new IntakeSessionError(400, {
      error: 'Unknown provider',
      message: `Provider '${providerType}' is not supported.`
    });
  }

  if (!setting) {
    console.log('⚠️ Using API keys from .env file as fallback (database settings not configured)');
  }

  // Resolve the persistent patient record by the entered phone / clinic ID. If the patient
  // already exists it's a RETURN visit (we keep their history and update it); otherwise create
  // a new record. No phone → anonymous one-off session (patient_id 0).
  let patientId = 0;
  let isReturning = false;
  let existingPatient: any = null;
  const phoneTrimmed = (phone && String(phone).trim()) || '';
  if (phoneTrimmed) {
    try {
      existingPatient = await db.findPatientByPhone(phoneTrimmed);
      if (existingPatient) {
        isReturning = true;
      } else {
        existingPatient = await db.createPatient(phoneTrimmed);
      }
      patientId = existingPatient.id;
      await db.incrementPatientVisit(patientId); // a visit is starting now
    } catch (e: any) {
      console.error('Patient resolve failed:', e?.message || e); // never block the session on this
    }
  }

  // Create session in database first. If we know a returning patient's name, label the session
  // with it; otherwise use the placeholder until the agent collects the name by voice.
  const insertedData = await db.createSession({
    patient_id: patientId,
    patient_name: (isReturning && existingPatient?.name) ? existingPatient.name : sessionPatientName,
    provider: providerType,
    language: sessionLanguage,
    status: 'active',
    start_time: new Date(),
    end_time: null,
    red_flags_detected: 0,
    source
  } as any);

  // Avoid logging PHI (patient name) or secrets (API keys in `setting`).
  const sessionId = insertedData.id;
  console.log(` Session created: ${sessionId} (provider=${providerType}, patient=${patientId || 'anon'}, returning=${isReturning}, source=${source})`);

  // Record patient consent (auditable)
  await db.recordConsent(sessionId);
  await db.insertAuditLog({
    action: 'consent_given',
    details: JSON.stringify({ consent: true, source }), // don't store the patient name in audit details (PHI)
    session_id: sessionId,
    ip_address: ip
  });
  await db.insertAuditLog({
    action: 'session_started',
    details: JSON.stringify({ clientIp: ip, userAgent, model: setting?.model, voice: setting?.voice, source }),
    session_id: sessionId,
    ip_address: ip
  });

  // Initialize the realtime pipeline based on provider type.
  if (providerType === 'openai') {
    const config = {
      sessionId,
      instructions: setting?.medical_instructions || MEDICAL_INTAKE_INSTRUCTIONS,
      voice: setting?.voice || 'alloy',
      temperature: setting?.temperature || 0.6,
      maxResponseLength: setting?.max_response_length || 200,
      model: setting?.model || 'gpt-4o-realtime-preview',
      apiKey: setting?.openai_api_key || process.env.OPENAI_API_KEY
    };
    try {
      const conn = await realtimeManager.createRealtimeSession(config);
      if (!conn) throw new Error('Realtime connection failed to initialize');
      console.log(`📝 Session ${sessionId} started successfully with Realtime connection`);
    } catch (error: any) {
      console.error('Failed to create Realtime session:', error);
      await db.updateSessionStatus(sessionId, 'error');
      await db.insertAuditLog({ action: 'session_start_failed', details: JSON.stringify({ error: error.message }), session_id: sessionId, ip_address: ip });
      throw new IntakeSessionError(500, {
        error: 'Failed to create session',
        message: error.message,
        details: 'Check your OpenAI API key and Realtime API access'
      });
    }
  } else if (providerType === 'sarvam') {
    // Sarvam: orchestrated STT -> LLM -> TTS pipeline behind the same realtime contract.
    const config = {
      sessionId,
      instructions: setting?.medical_instructions || MEDICAL_INTAKE_INSTRUCTIONS,
      voice: setting?.voice || 'anushka',
      temperature: setting?.temperature || 0.6,
      maxResponseLength: setting?.max_response_length || 200,
      model: setting?.model || 'sarvam-30b',
      language: sessionLanguage,
      engineMap: parseEngineMapSetting((setting as any)?.engine_map),
      patientId,
      isReturning,
      patientName: (isReturning && existingPatient?.name) ? existingPatient.name : undefined,
      patientHistory: (isReturning && existingPatient?.medical_summary) ? existingPatient.medical_summary : undefined,
      apiKey: process.env.SARVAM_API_KEY
    };
    try {
      const conn = await realtimeManager.createRealtimeSession(config);
      if (!conn) throw new Error('Sarvam pipeline failed to initialize');
      console.log(`📝 Session ${sessionId} started successfully with Sarvam pipeline`);
    } catch (error: any) {
      console.error('Failed to create Sarvam session:', error);
      await db.updateSessionStatus(sessionId, 'error');
      await db.insertAuditLog({ action: 'session_start_failed', details: JSON.stringify({ error: error.message }), session_id: sessionId, ip_address: ip });
      throw new IntakeSessionError(500, {
        error: 'Failed to create session',
        message: error.message,
        details: 'Check your Sarvam API subscription key'
      });
    }
  }
  // retellai: nothing to init here (the web call is started separately).

  const patient = existingPatient ? {
    name: existingPatient.name || null,
    visitCount: (existingPatient.visit_count || 0) + 1,
    hasHistory: !!(existingPatient.medical_summary && String(existingPatient.medical_summary).trim())
  } : null;

  return { sessionId, provider: providerType, isReturning, patient, status: 'active' };
}
