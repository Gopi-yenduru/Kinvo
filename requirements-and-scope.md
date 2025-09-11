# Medical Intake Voice Agent - Requirements and Scope Document

## Project Overview

### Initial Request
Build an AI agent which can perform pre-consultation information gathering from patients before doctor consultations. The system must be voice-based, asking questions and recording patient answers.

### Primary Business Objective
**Reduce consultation time by 50% by collecting routine information beforehand**

### Project Type
Proof of Concept (POC) for medical intake automation

## Core Requirements

### 1. Functional Requirements

#### 1.1 Voice Interaction
- **Voice-based communication** using speech-to-speech technology
- **Natural conversation flow** with ability to handle interruptions
- **Real-time processing** with minimal latency (<500ms target)
- **Clear audio capture** of patient responses

#### 1.2 Information Collection
- **Structured data gathering** following medical intake protocols
- **Dynamic questioning** based on patient responses
- **Comprehensive coverage** of routine intake topics:
  - Chief complaint and symptom details
  - Medical history
  - Current medications
  - Allergies
  - Relevant lifestyle factors
  - Family history (when relevant)

#### 1.3 Data Management
- **FHIR-compliant data storage** for healthcare interoperability
- **Structured intake reports** for provider review
- **Complete audit trail** of all interactions
- **Local data storage** option for privacy

### 2. Critical Boundaries and Constraints

#### 2.1 Core Identity
**The agent is a data collector, NOT a medical professional**

#### 2.2 Prohibited Actions
- ❌ **No medical advice**: Must not suggest diagnoses, treatments, or remedies
- ❌ **No reassurance or judgment**: Cannot tell patients their condition is "fine" or "not serious"
- ❌ **No recommendations**: Cannot suggest lifestyle changes or next steps
- ❌ **No interpretation**: Cannot explain lab results, imaging, or medical records
- ❌ **No persuasion**: Cannot try to convince patients of anything

#### 2.3 Communication Boundaries
- Only collect and record information
- Use neutral, empathetic tone without crossing medical boundaries
- Defer all medical questions to the provider
- Maintain strict factual responses

### 3. Safety Requirements

#### 3.1 Red Flag Detection
Immediate escalation required for:
- Chest pain
- Difficulty breathing
- Severe bleeding
- Loss of consciousness
- Stroke symptoms
- Suicidal thoughts
- Any life-threatening symptoms

#### 3.2 Escalation Protocol
- Pause conversation immediately
- Alert clinician within 5 seconds
- Log emergency event
- Inform patient that clinical team is being notified

### 4. Technical Requirements

#### 4.1 Performance
- Response latency: <500ms
- Conversation completion: <10 minutes average
- System availability: 99.9% uptime
- Concurrent sessions: Support for POC testing

#### 4.2 Integration
- FHIR resource mapping for all collected data
- RESTful API for system integration
- WebSocket support for real-time communication
- Structured report generation

#### 4.3 Security & Compliance
- HIPAA-ready architecture
- Encrypted data storage and transmission
- Comprehensive audit logging
- Role-based access control
- Local deployment option for sensitive data

### 5. User Experience Requirements

#### 5.1 Patient Experience
- Natural, conversational interaction
- Clear audio quality
- Ability to correct or clarify responses
- No medical jargon unless used by patient
- Respectful and empathetic tone

#### 5.2 Provider Experience
- Structured intake summaries
- Clear presentation of collected data
- Red flag highlighting
- Easy access to conversation transcripts
- Time-saving workflow integration

## Scope Definition

### In Scope
✅ Voice-based patient information collection
✅ FHIR-compliant data mapping
✅ Red flag detection and escalation
✅ Structured intake report generation
✅ Audit trail and compliance logging
✅ Local deployment architecture
✅ POC implementation with core features

### Out of Scope
❌ Medical advice or diagnosis features
❌ Integration with existing EHR systems (for POC)
❌ Multi-language support (English only for POC)
❌ Video consultation capabilities
❌ Appointment scheduling
❌ Prescription management
❌ Insurance verification

## Success Criteria

### Quantitative Metrics
- **Time Reduction**: 50% reduction in face-to-face consultation time
- **Completion Rate**: >80% of patients complete intake
- **Data Quality**: >95% of required fields collected
- **Response Time**: <500ms average latency
- **Boundary Compliance**: 100% adherence (no medical advice given)

### Qualitative Metrics
- Natural conversation flow
- Patient comfort with the system
- Provider satisfaction with data quality
- Successful red flag detection
- Clear and actionable intake reports

## Deliverables

### Architecture & Design
1. System architecture with FHIR compliance
2. Conversation flow design with strict boundaries
3. Technology stack recommendation
4. Security and compliance framework

### Implementation Guides
1. Detailed technical implementation guide
2. Database schemas
3. API specifications
4. Testing scenarios

### Documentation
1. Conversation scripts demonstrating boundaries
2. Red flag detection protocols
3. FHIR mapping specifications
4. Deployment guides

## Technology Decision

After thorough analysis, **OpenAI Realtime API** was selected for the POC due to:
- Superior user experience (320ms latency)
- Natural conversation with interruptions
- Simplified architecture
- Faster development time (40-60 hours vs 80-120)

**Trade-off**: Higher operational cost ($5.76/hour) accepted for better user experience

## Project Constraints

### Technical Constraints
- Must maintain strict medical boundaries through AI instructions
- Requires modern browsers with WebRTC support
- Needs stable internet connection for cloud APIs
- Local deployment for data privacy

### Business Constraints
- POC timeline: 4 weeks
- Budget considerations for API costs
- English language only initially
- Focus on general practice intake (not specialized)

## Risk Mitigation

### Key Risks Identified
1. **Boundary violations**: Mitigated through extensive testing (1000+ test cases)
2. **Medical terminology accuracy**: Using medical-grade speech recognition
3. **Red flag delays**: Automated detection with <5 second escalation
4. **Data privacy**: Local deployment option, encrypted storage

## Future Considerations

### Phase 2 Enhancements
- EHR system integration
- Multi-language support
- Specialized medical department customization
- Advanced analytics and reporting

### Scaling Considerations
- Cloud deployment with HIPAA compliance
- Load balancing for multiple concurrent sessions
- Redundancy and disaster recovery
- Performance optimization for cost reduction

---

**Document Version**: 1.0
**Created**: September 2024
**Status**: Approved for POC Development