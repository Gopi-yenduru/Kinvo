⸻

🩺 Doctor Dashboard – End-to-End Flow

1. Login & Dashboard Home
	•	Doctor logs in securely (MFA).
	•	Sees dashboard with:
	•	Search bar (by patient name, phone, MRN).
	•	Patient list (Recent, Upcoming, All).
	•	Quick action: “Send Interview Link.”

⸻

2. Patient Onboarding (Not required, can be integrated with existing EHR or Patient record systems)
	•	Doctor (or staff) clicks “Add Patient” → enters:
	•	Name
	•	Phone number
	•	Date of birth
	•	New / Existing patient toggle
	•	System generates a unique interview link.
	•	Link sent via SMS (or WhatsApp/email fallback).

⸻

3. Patient Completes Interview
	•	Patient clicks link → launches Healthyoda voice agent (web/mobile).
	•	Agent conducts structured, real-time interview:
	•	Patient describes symptoms.
	•	AI asks clinical follow-ups.
	•	Urgent complaints trigger escalation → “We recommend contacting emergency services.”
	•	Transcript & raw audio stored securely.

⸻

4. Summarization & Draft Note
	•	Once patient finishes, system generates:
	•	SOAP note draft (Subjective + Assessment + Plan).
	•	Relevant negatives included.
	•	Key flags highlighted (e.g., “Chest pain reported, no shortness of breath”).
	•	Draft stored in patient’s chart.

⸻

5. Doctor Review & Edit
	•	Doctor opens patient record → sees:
	•	Transcript (full interview).
	•	Draft note (editable text box).
	•	Buttons: “Accept,” “Edit,” “Save.”
	•	Doctor can edit and finalize with minimal typing.
	•	Final note synced to EHR (via FHIR API).

⸻

6. Patient Search & Records
	•	Doctor can search:
	•	By name, phone number, MRN, or diagnosis keyword.
	•	Patient profile includes:
	•	Demographics.
	•	Past visits with Healthyoda.
	•	Summarized SOAP notes.
	•	Audio recordings (optional).

⸻

7. Memory Layer (Longitudinal Context)
	•	Each patient has a long-term memory timeline:
	•	Stores prior SOAP notes, flagged complaints, and interview transcripts.
	•	When a new interview starts, Healthyoda retrieves context from past visits (e.g., “Patient had GERD symptoms last month, check if improved or worsened.”).
	•	Ensures continuity of care across multiple interactions.
	•	Doctors can review memory and toggle what is carried forward (to prevent irrelevant noise).

⸻

8. Notifications & Status Tracking
	•	Doctor sees patient interview status:
	•	“Link sent”
	•	“Interview in progress”
	•	“Interview complete – draft ready”
	•	Alerts for urgent cases (ER red flags).

⸻

🔑 Summary of Full Flow
	1.	Doctor logs in → dashboard.
	2.	Add/Search Patient.
	3.	Send interview link via SMS.
	4.	Patient completes interview with Healthyoda voice agent.
	5.	AI generates draft SOAP note.
	6.	Doctor reviews/edits → saves to chart.
	7.	Search & retrieve patient records easily.
	8.	Memory layer stores prior notes → context-aware future interviews.

⸻
