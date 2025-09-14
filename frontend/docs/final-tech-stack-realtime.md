# Medical Intake Voice Agent - Final Technology Stack (Realtime API)

## 🎯 Selected Technology Stack

### Core Voice Service
**OpenAI Realtime API**
- All-in-one speech-to-speech processing
- Ultra-low latency (~320ms)
- Natural conversation with interruptions
- Built-in GPT-4 intelligence
- WebRTC-based streaming
- Cost: $5.76/hour ($0.06/min input, $0.24/min output)

### Backend Services
**Node.js + Express + TypeScript**
- WebSocket support for Realtime API
- Strong typing for medical data
- Excellent async handling
- Large healthcare ecosystem

### Database
**PostgreSQL (Local Docker)**
- JSONB support for FHIR resources
- ACID compliance for medical data
- Structured storage for intake reports
- Audit trail capabilities

### Session Management
**Redis (Local Docker)**
- Real-time session state
- Fast access for conversation context
- Pub/sub for event handling
- TTL for automatic cleanup

### Frontend
**React + TypeScript**
- Modern component architecture
- WebRTC audio handling
- Real-time UI updates
- **UI Framework**: Tailwind CSS
- **State Management**: Zustand

### Deployment
**Local On-Device**
- Frontend: Vite dev server (port 5173)
- Backend: Node.js server (port 3000)
- WebSocket: Integrated with backend
- Database: PostgreSQL Docker container
- Cache: Redis Docker container

## 📋 Architecture Highlights

### Realtime API Configuration
```javascript
{
  instructions: "Strict medical intake boundaries...",
  voice: "nova",
  temperature: 0.1,  // Minimal variation
  max_response_length: 100,  // Concise responses
  tools: [
    "red_flag_detected",
    "save_response",
    "log_conversation"
  ]
}
```

### Key Design Decisions
1. **Realtime API** for superior user experience
2. **Instruction-based boundaries** with rigorous testing
3. **Function calling** for red flag detection
4. **Local deployment** for data privacy
5. **FHIR compliance** from the start

## 🏗️ System Flow

```
1. Patient speaks
   ↓
2. WebRTC captures audio
   ↓
3. Realtime API processes (320ms)
   ↓
4. Parallel execution:
   - Agent responds via audio
   - Functions save data
   - Red flags trigger alerts
   ↓
5. Session state updated in Redis
   ↓
6. FHIR resources created
   ↓
7. PostgreSQL persists data
```

## 💻 Development Setup

### Required Software
- Node.js 18+ LTS
- Docker Desktop
- Git
- VS Code
- OpenAI API key with Realtime access

### Quick Start
```bash
# 1. Clone repository
git clone [repo-url]
cd medical-intake-agent

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Add OpenAI API key

# 4. Start Docker services
docker-compose up -d

# 5. Run migrations
npm run db:migrate

# 6. Start development
npm run dev

# 7. Open browser
# http://localhost:5173
```

## 🔒 Security & Compliance

### Data Protection
- All patient data stored locally
- WebRTC encryption for audio
- PostgreSQL encryption at rest
- Redis password protection
- No cloud storage of PHI

### Audit Trail
- Every conversation logged
- Function calls tracked
- Red flag events recorded
- Access logs maintained
- HIPAA-ready architecture

## 📊 Performance Metrics

- **Response Latency**: ~320ms
- **Red Flag Detection**: <100ms
- **FHIR Conversion**: <50ms
- **Session Creation**: <10ms
- **Database Write**: <20ms

## 🚀 Implementation Phases

### Week 1-2: Core POC
- Realtime API integration
- Basic conversation flow
- Red flag detection
- Database setup

### Week 3: Enhancement
- FHIR mapping
- Report generation
- Clinician dashboard
- Testing suite

### Week 4: Production Prep
- Boundary testing (1000+ cases)
- Performance optimization
- Documentation
- Deployment preparation

## ⚡ Cost Optimization

### Strategies to Reduce Costs
1. **Concise Responses**: Keep agent responses under 10 words
2. **Smart Silence Detection**: Minimize dead air time
3. **Visual Feedback**: Use screen for lists instead of speech
4. **Hybrid Approach**: Use traditional stack for complex cases

### Expected Costs
- Development: 40-60 hours
- Monthly Operations (100 hrs): $576
- Break-even vs traditional: 16-24 months

## 🎯 Success Criteria

- ✅ 100% boundary compliance (no medical advice)
- ✅ <5 second red flag escalation
- ✅ 95%+ data completeness
- ✅ <10 minute average intake time
- ✅ 320ms response latency
- ✅ 99.9% uptime

## 🔄 Migration Path

When ready for production:
1. Add SSL certificates
2. Deploy to cloud with HIPAA compliance
3. Implement redundancy
4. Add monitoring/alerting
5. Scale horizontally as needed

## 📝 Key Differentiators

1. **Natural Conversation**: 10x faster than traditional approaches
2. **Strict Boundaries**: Instruction-based control with extensive testing
3. **Real-time Safety**: Immediate red flag detection and escalation
4. **FHIR Native**: Healthcare interoperability from day one
5. **Privacy First**: Local deployment option for sensitive data