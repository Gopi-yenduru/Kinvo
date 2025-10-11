# Medical Intake Voice Agent

A revolutionary AI-powered medical intake system with real-time voice processing, professional medical-grade UI, and comprehensive session management.

![Medical Intake Voice Agent](https://img.shields.io/badge/Medical-AI%20Voice%20Agent-blue?style=for-the-badge)
![Node.js](https://img.shields.io/badge/Node.js-18+-green?style=flat-square)
![React](https://img.shields.io/badge/React-19-blue?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-5+-blue?style=flat-square)
![OpenAI](https://img.shields.io/badge/OpenAI-Realtime%20API-orange?style=flat-square)

## 🎯 Features

### 🎙️ **Real-Time Voice Processing**
- **OpenAI Realtime API Integration**: Advanced voice-to-voice AI conversations
- **Live Audio Streaming**: Real-time audio processing with WebSocket connections
- **Voice Activity Detection**: Automatic speech start/stop detection
- **High-Quality Audio**: 24kHz PCM16 audio processing for crystal-clear conversations

### 🏥 **Medical-Grade Interface**
- **Professional Dashboard**: Real-time statistics, analytics, and session monitoring
- **Session Management**: Comprehensive session tracking with filtering and search
- **Transcript System**: Complete conversation logging with professional transcript viewer
- **Red Flag Detection**: Automatic detection and alerting for critical medical symptoms

### 🎨 **Modern UI/UX**
- **Revolutionary Design**: Complete redesign with medical-focused color palette
- **Responsive Layout**: Perfect on desktop, tablet, and mobile devices
- **Professional Components**: Medical-grade cards, buttons, and navigation
- **Accessibility**: WCAG compliant with proper focus states and keyboard navigation

### 📊 **Advanced Analytics**
- **Real-Time Statistics**: Live session counts, completion rates, and duration tracking
- **Red Flag Monitoring**: Critical symptom detection and clinical team alerts
- **Session History**: Complete audit trail with searchable conversation logs
- **Export Functionality**: Transcript export and data management

## 🖥️ System Requirements

### **macOS Requirements**
- **macOS**: 10.15 (Catalina) or later
- **Node.js**: 18.0.0 or later
- **npm**: 8.0.0 or later
- **Memory**: 4GB RAM minimum, 8GB recommended
- **Storage**: 2GB free space
- **Browser**: Chrome 90+, Safari 14+, or Firefox 88+

### **Hardware Requirements**
- **Microphone**: Built-in or external microphone for voice input
- **Speakers/Headphones**: Audio output device for AI voice responses
- **Internet**: Stable broadband connection (minimum 1 Mbps upload/download)

### **Database Requirements**
- **SQL Server**: Microsoft SQL Server 2019 or later (or Azure SQL Database)
- **Database Access**: Network connectivity to SQL Server instance
- **Permissions**: Database user with read/write permissions on target database

## 🚀 Quick Start

### **Option 1: Automated Setup (Recommended)**

```bash
# Clone the repository
git clone <repository-url>
cd Pre-Consultation

# Run the automated setup script
chmod +x setup.sh
./setup.sh
```

### **Option 2: Manual Setup**

#### **1. Prerequisites Installation**

```bash
# Install Node.js (if not already installed)
# Download from: https://nodejs.org/en/download/
# Or using Homebrew:
brew install node

# Verify installation
node --version  # Should be 18.0.0 or later
npm --version   # Should be 8.0.0 or later
```

#### **2. Project Setup**

```bash
# Clone the repository
git clone <repository-url>
cd Pre-Consultation

# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install
```

#### **3. Environment Configuration**

```bash
# Copy environment template
cd ../backend
cp .env.example .env

# Edit the .env file with your OpenAI API key
nano .env
```

**Required Environment Variables:**
```env
# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key_here

# Server Configuration
PORT=3001
NODE_ENV=development

# Database Configuration (SQL Server)
# Database connection is configured in src/dbConfig.ts
# Update the connection details in dbConfig.ts for your environment

# Security Configuration
SESSION_SECRET=your_session_secret_here
JWT_SECRET=your_jwt_secret_here

# Optional: For healthcare compliance logging
AUDIT_LOG_ENABLED=true
HOSPITAL_SYSTEM_ID=your_hospital_system_id

# CORS Configuration
FRONTEND_URL=http://localhost:5173
```

#### **4. OpenAI API Key Setup**

1. **Get OpenAI API Key**:
   - Visit [OpenAI Platform](https://platform.openai.com/api-keys)
   - Create an account or sign in
   - Generate a new API key
   - **Important**: Ensure you have access to the Realtime API (may require waitlist approval)

2. **Add to Environment**:
   ```bash
   # Replace 'your_openai_api_key_here' with your actual API key
   OPENAI_API_KEY=sk-your-actual-api-key-here
   ```

#### **5. Start the Application**

```bash
# Terminal 1: Start Backend Server
cd backend
npm run dev

# Terminal 2: Start Frontend Development Server
cd frontend
npm run dev
```

#### **6. Access the Application**

Open your browser and navigate to:
- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:3001

## 📁 Project Structure

```
Pre-Consultation/
├── README.md                 # This file
├── setup.sh                  # Automated setup script
├── package.json              # Root package configuration
├── TECHNICAL_DOCUMENTATION.md # Technical details
│
├── backend/                  # Node.js/Express Backend
│   ├── package.json         # Backend dependencies
│   ├── tsconfig.json        # TypeScript configuration
│   ├── .env.example         # Environment template
│   ├── .env                 # Environment variables (create this)
│   └── src/
│       ├── server.ts        # Express server setup
│       ├── realtime.ts      # OpenAI Realtime API integration
│       ├── database-manager.ts # SQL Server database management
│       ├── dbConfig.ts      # Database connection configuration
│       ├── dbconnection.ts  # Database connection pool
│       ├── auth.ts          # Authentication middleware
│       └── constants.ts     # Application constants
│
└── frontend/                # React/TypeScript Frontend
    ├── package.json         # Frontend dependencies
    ├── tsconfig.json        # TypeScript configuration
    ├── vite.config.ts       # Vite build configuration
    ├── index.html           # HTML template
    └── src/
        ├── App.tsx          # Main application component
        ├── App.css          # Complete styling system
        ├── main.tsx         # Application entry point
        ├── components/      # Reusable UI components
        │   └── Layout/      # Layout components
        └── pages/           # Application pages
            ├── Dashboard.tsx # Analytics dashboard
            ├── Session.tsx   # Voice session interface
            └── Sessions.tsx  # Session management
```

## 🔧 Development Commands

### **Backend Commands**
```bash
cd backend

# Development with hot reload
npm run dev

# Production build
npm run build

# Start production server
npm start

# Run tests
npm test
```

### **Frontend Commands**
```bash
cd frontend

# Development server
npm run dev

# Production build
npm run build

# Preview production build
npm run preview

# Type checking
npm run type-check

# Linting
npm run lint
```

## 🎮 Usage Guide

### **1. Starting a Voice Session**

1. **Navigate to Dashboard**: Open http://localhost:5173
2. **Click "Start New Session"**: Blue button in the dashboard
3. **Allow Microphone Access**: Browser will request microphone permissions
4. **Begin Conversation**: Speak clearly when you see "Recording" indicator
5. **AI Response**: Listen to the AI agent's voice responses
6. **End Session**: Click "End Session" when complete

### **2. Viewing Session History**

1. **Navigate to Sessions**: Click "Sessions" in navigation or use the sessions button
2. **Browse Sessions**: View all past sessions with status indicators
3. **Filter Sessions**: Use filter tabs (All, Completed, Active, Errors)
4. **Search Sessions**: Use the search box to find specific sessions
5. **View Transcript**: Click "View Transcript" on any session card

### **3. Managing Transcripts**

1. **Open Transcript**: Click "View Transcript" button after session completion
2. **Review Conversation**: See complete conversation with timestamps
3. **Copy Transcript**: Use "Copy Transcript" button to copy to clipboard
4. **Export Data**: Use export functionality for data management

## 🔍 Troubleshooting

### **Common Issues**

#### **"Cannot connect to backend" Error**
```bash
# Check if backend is running
curl http://localhost:3001/api/health

# If not running, start backend
cd backend && npm run dev
```

#### **"OpenAI API Error" Messages**
```bash
# Check your API key in .env file
cat backend/.env | grep OPENAI_API_KEY

# Verify API key is valid
# Test at: https://platform.openai.com/playground
```

#### **Microphone Not Working**
1. **Check Browser Permissions**: Ensure microphone access is allowed
2. **Test Microphone**: Use system preferences to test microphone
3. **Try Different Browser**: Chrome generally has best WebRTC support
4. **Check HTTPS**: Some browsers require HTTPS for microphone access

#### **Audio Playback Issues**
1. **Check Volume**: Ensure system volume is up
2. **Test Speakers**: Play other audio to verify speakers work
3. **Browser Audio**: Check browser audio settings
4. **Clear Cache**: Clear browser cache and reload

### **Performance Optimization**

#### **For Better Voice Quality**
- Use a quiet environment
- Speak clearly and at normal pace
- Use a good quality microphone
- Ensure stable internet connection

#### **For Better Performance**
- Close unnecessary browser tabs
- Ensure sufficient RAM (8GB recommended)
- Use wired internet connection when possible
- Keep browser updated

## 🚀 Deployment

### **Railway Deployment (Recommended)**

1. **Connect Repository**: Link your GitHub repository to Railway
2. **Environment Variables**: Set the following in Railway dashboard:
   ```env
   OPENAI_API_KEY=sk-your-openai-api-key
   NODE_ENV=production
   SESSION_SECRET=your-secure-session-secret
   JWT_SECRET=your-secure-jwt-secret
   AUDIT_LOG_ENABLED=true
   HOSPITAL_SYSTEM_ID=your-hospital-id
   ```
3. **Database Configuration**: Railway will automatically detect the Dockerfile and deploy the application
4. **Domain**: Railway provides a custom domain or you can use your own

### **AWS ECS Deployment**

1. **Build and Push Docker Image**:
   ```bash
   # Build the image
   docker build -t medical-intake-voice-agent .

   # Tag and push to ECR
   aws ecr get-login-password --region REGION | docker login --username AWS --password-stdin ACCOUNT-ID.dkr.ecr.REGION.amazonaws.com
   docker tag medical-intake-voice-agent:latest ACCOUNT-ID.dkr.ecr.REGION.amazonaws.com/medical-intake-voice-agent:latest
   docker push ACCOUNT-ID.dkr.ecr.REGION.amazonaws.com/medical-intake-voice-agent:latest
   ```

2. **Update task-definition.json**: Replace `ACCOUNT-ID` and `REGION` with your AWS values

3. **Deploy to ECS**:
   ```bash
   aws ecs update-service --cluster your-cluster --service your-service --task-definition medical-intake-voice-agent --force-new-deployment
   ```

### **Local Docker Deployment**

```bash
# Build and run locally
docker build -t medical-intake-voice-agent .
docker run -p 80:80 \
  -e OPENAI_API_KEY=your-api-key \
  -e NODE_ENV=production \
  -e SESSION_SECRET=your-secret \
  -e JWT_SECRET=your-jwt-secret \
  medical-intake-voice-agent
```

## 🔐 Security & Privacy

### **Data Handling**
- **Local Storage**: All session data stored locally in SQLite database
- **No Cloud Storage**: Conversations not stored in external cloud services
- **OpenAI Privacy**: Audio sent to OpenAI for processing (see OpenAI privacy policy)
- **Secure Transmission**: All API calls use HTTPS encryption

### **API Key Security**
- **Environment Variables**: API keys stored in environment files
- **Never Commit**: .env files excluded from version control
- **Rotate Keys**: Regularly rotate OpenAI API keys
- **Monitor Usage**: Monitor API usage in OpenAI dashboard

## 🤝 Contributing

### **Development Setup**
1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes
4. Test thoroughly
5. Commit changes: `git commit -m 'Add amazing feature'`
6. Push to branch: `git push origin feature/amazing-feature`
7. Open a Pull Request

### **Code Standards**
- **TypeScript**: Use TypeScript for all new code
- **ESLint**: Follow ESLint configuration
- **Prettier**: Use Prettier for code formatting
- **Testing**: Add tests for new features
- **Documentation**: Update documentation for changes

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

### **Getting Help**
- **Documentation**: Check TECHNICAL_DOCUMENTATION.md for detailed technical info
- **Issues**: Create GitHub issues for bugs or feature requests
- **Discussions**: Use GitHub Discussions for questions and community support

### **Professional Support**
For enterprise deployments or professional support, please contact the development team.

---

## 🎉 Acknowledgments

- **OpenAI**: For the revolutionary Realtime API
- **React Team**: For the amazing React framework
- **Vite**: For lightning-fast development experience
- **TypeScript**: For type safety and developer experience

---

**Built with ❤️ for the medical community**

*Revolutionizing medical intake with AI-powered voice technology*