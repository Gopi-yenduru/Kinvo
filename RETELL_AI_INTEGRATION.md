# Retell AI Integration Documentation

## Overview

This project is a **Medical Intake Voice Agent** system that integrates multiple AI providers for voice-based medical consultations. Retell AI is one of the supported providers, offering an alternative to OpenAI's Realtime API with different implementation approaches.

## Architecture Overview

The system uses a **provider pattern** where different AI services can be swapped dynamically:

- **OpenAI Provider**: Uses WebSocket-based realtime connections
- **Retell AI Provider**: Uses web call sessions with the Retell Web SDK
- **Provider Factory**: Manages provider instantiation and switching

## Backend Implementation

### Provider Architecture

The Retell AI integration follows the `BaseProvider` and `WebCallProvider` interfaces:

```typescript
class RetellAIProvider implements BaseProvider, WebCallProvider
```

### Key Components

#### 1. RetellAIProvider.ts

**Location**: `backend/src/providers/RetellAIProvider.ts`

**Core Features**:
- Uses Retell SDK (`retell-sdk`) for API interactions
- Implements web call creation instead of WebSocket streaming
- Provides function tools for medical workflows
- Handles database operations for responses and red flags

**Required Environment Variables**:
- `RETELLAI_API_KEY`: API authentication key
- `RETELLAI_AGENT_ID`: Pre-configured agent identifier

#### 2. Provider Factory

**Location**: `backend/src/providers/ProviderFactory.ts`

Supports dynamic provider switching:
```typescript
const providerType = 'retellai'; // or 'openai', 'vapi'
const provider = ProviderFactory.getProvider(providerType);
```

#### 3. RealtimeManager Integration

**Location**: `backend/src/realtime.ts`

The RealtimeManager delegates to providers:
```typescript
async createRealtimeSession(config: RealtimeConfig): Promise<WebSocket | null> {
  return this.provider.createRealtimeSession(config);
}
```

### Function Tools

Retell AI provider implements specialized medical function tools:

1. **red_flag_detected**: Alerts for critical symptoms requiring immediate attention
2. **save_response**: Saves patient Q&A to database
3. **log_conversation**: Maintains audit trail of conversations

## Frontend Integration

### Settings Configuration

**Location**: `frontend/src/pages/Settings.tsx`

**Retell AI Specific Fields**:
- **RetellAI API Key**: Authentication credential
- **RetellAI Agent ID**: Pre-configured agent identifier
- Provider selection dropdown includes RetellAI option

**Validation**: Save button disabled until both API key and Agent ID are configured.

### Session Management

**Location**: `frontend/src/pages/Session.tsx`

**Retell AI Workflow**:

1. **Session Creation**:
   ```typescript
   if (data.provider === 'retellai') {
     // Start web call directly
     const response = await fetch(`/api/sessions/${sessionId}/start-web-call`);
   }
   ```

2. **Web Client Integration**:
   - Uses `retell-client-js-sdk` for browser-based voice calls
   - Handles real-time transcripts and audio events
   - Manages call lifecycle (start/end)

3. **Event Handling**:
   - `call_started`: Call initialization
   - `call_ended`: Call completion and transcript retrieval
   - `realtime_transcript`: Streaming user speech
   - `transcript`: Final conversation transcripts
   - `agent_start_talking`/`agent_stop_talking`: Turn management

## API Endpoints

### Session Management

#### POST `/api/sessions/start`
- Creates session in database
- Validates provider configuration
- For Retell AI: Only creates DB record (no realtime connection)

#### POST `/api/sessions/:sessionId/start-web-call`
- **Retell AI specific endpoint**
- Creates web call using RetellAIProvider
- Returns: `call_id`, `access_token`, `agent_id`
- Stores call metadata for transcript retrieval

#### GET `/api/sessions/:sessionId/retell-transcript`
- Retrieves complete transcript from Retell AI API
- Uses `get-call` endpoint with stored `call_id`
- Saves transcript items to database
- Updates session status when call ends

### Configuration

#### GET/POST `/api/settings/config`
- Manages provider settings including Retell AI credentials
- Stores API keys and agent IDs in database

## Data Flow

### Session Lifecycle

1. **Configuration**: User selects RetellAI provider in settings
2. **Session Start**: Backend validates Retell AI credentials
3. **Web Call Creation**: Frontend calls `/start-web-call` endpoint
4. **Voice Interaction**: Retell Web Client handles audio streaming
5. **Function Calls**: AI triggers medical workflows (red flags, response saving)
6. **Transcript Retrieval**: Automatic fetching when call ends
7. **Session Completion**: Database status updated

### Database Integration

**Function Call Handlers**:
- **Red Flags**: Stored in `red_flag_events` table with severity levels
- **Responses**: Saved as intake responses with categorization
- **Conversations**: Full audit trail in conversation logs

## Environment Configuration

### Required Variables

```env
# Retell AI Configuration
RETELLAI_API_KEY=your_retell_api_key
RETELLAI_AGENT_ID=your_agent_id
```

### Database Settings

Settings stored in database allow per-session configuration:
```sql
-- Settings table includes
retellai_api_key
retellai_agent_id
provider (set to 'retellai')
```

## Usage Flow

### For Administrators

1. **Configure Credentials**: Set Retell AI API key and Agent ID in Settings page
2. **Select Provider**: Choose "RetellAI" from provider dropdown
3. **Save Settings**: System validates configuration before allowing save

### For Medical Staff

1. **Start Session**: Create new intake session (provider automatically selected)
2. **Begin Call**: Click "Start Call" - initiates Retell AI web call
3. **Voice Interaction**: AI agent conducts medical intake conversation
4. **Monitor Red Flags**: System alerts for critical symptoms
5. **Review Transcripts**: Complete conversation logs available after call

## Key Differences from OpenAI

| Feature | OpenAI Realtime | Retell AI |
|---------|----------------|-----------|
| Connection | WebSocket streaming | Web call sessions |
| Audio Handling | Direct PCM streaming | SDK-managed |
| Transcript Access | Real-time streaming | Post-call API retrieval |
| Function Tools | Realtime API events | Web call function calls |
| Session Management | Persistent connections | Call-based sessions |
| Frontend SDK | Custom WebSocket client | Retell Web Client |

## Error Handling

### Configuration Errors
- Missing API key or Agent ID prevents session start
- Clear error messages guide users to settings page

### API Errors
- Invalid credentials return 401/403 responses
- Call failures logged with audit trails
- Graceful fallback to error states

### Network Issues
- Web call timeouts handled by SDK
- Connection recovery managed by Retell Web Client
- Session status updated appropriately

## Security Considerations

- **API Keys**: Stored encrypted in database and environment
- **Access Tokens**: Short-lived tokens generated per call
- **Audit Logging**: All function calls and interactions logged
- **HIPAA Compliance**: Designed for healthcare data handling

## Future Enhancements

- **Multiple Agents**: Support for different medical specialties
- **Call Recording**: Enhanced audio storage and retrieval
- **Analytics**: Detailed call metrics and performance tracking
- **Multi-language**: Support for non-English medical consultations

This integration provides a robust, production-ready voice AI solution for medical intake workflows using Retell AI's web call technology.