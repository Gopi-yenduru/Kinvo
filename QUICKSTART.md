# Quick Start Guide

Get the Medical Intake Voice Agent running in 5 minutes! 🚀

## Prerequisites ✅

- **macOS 10.15+** (Catalina or later)
- **Node.js 18+** ([Download here](https://nodejs.org/))
- **OpenAI API Key** ([Get one here](https://platform.openai.com/api-keys))

## 1-Minute Setup 🏃‍♂️

### Option A: Automated Setup (Recommended)
```bash
# Clone and setup everything automatically
git clone <repository-url>
cd Pre-Consultation
chmod +x setup.sh
./setup.sh
```

### Option B: Manual Setup
```bash
# Clone the repository
git clone <repository-url>
cd Pre-Consultation

# Install dependencies
npm run install:all

# Setup environment
cp backend/.env.example backend/.env
# Edit backend/.env and add your OpenAI API key
```

## 2-Minute Configuration ⚙️

### Add Your OpenAI API Key
```bash
# Edit the environment file
nano backend/.env

# Replace this line:
OPENAI_API_KEY=your_openai_api_key_here

# With your actual API key:
OPENAI_API_KEY=sk-your-actual-api-key-here
```

## 3-Minute Launch 🚀

### Start the Application
```bash
# Option 1: Start both servers with one command
npm run dev

# Option 2: Start servers separately (in different terminals)
# Terminal 1:
cd backend && npm run dev

# Terminal 2:
cd frontend && npm run dev
```

### Access the Application
Open your browser and go to: **http://localhost:5173**

## 4-Minute First Session 🎙️

1. **Click "Start New Session"** on the dashboard
2. **Allow microphone access** when prompted
3. **Speak clearly** when you see the recording indicator
4. **Listen to the AI response** - it will ask medical intake questions
5. **Continue the conversation** until complete
6. **View your transcript** by clicking "View Transcript"

## 5-Minute Exploration 🔍

### Dashboard Features
- **Real-time Statistics**: See session counts and analytics
- **Quick Actions**: Start sessions and generate reports
- **Recent Activity**: Monitor latest sessions

### Sessions Management
- **Filter Sessions**: All, Completed, Active, Errors
- **Search Sessions**: Find specific sessions quickly
- **View Transcripts**: Complete conversation history
- **Export Data**: Download session information

### Voice Session Features
- **Real-time Conversation**: Natural voice interaction with AI
- **Live Transcription**: See what you're saying in real-time
- **Red Flag Detection**: Automatic alerts for critical symptoms
- **Session Controls**: Pause, resume, and end sessions

## Troubleshooting 🔧

### Common Issues & Quick Fixes

#### "Cannot connect to backend"
```bash
# Check if backend is running
curl http://localhost:3001/api/health
# If not running: cd backend && npm run dev
```

#### "OpenAI API Error"
```bash
# Check your API key
grep OPENAI_API_KEY backend/.env
# Make sure it starts with 'sk-' and is valid
```

#### "Microphone not working"
- **Chrome**: Click the microphone icon in address bar
- **Safari**: Go to Safari > Settings > Websites > Microphone
- **System**: Check System Preferences > Security & Privacy > Microphone

#### "No audio playback"
- Check system volume and browser audio settings
- Try refreshing the page
- Use Chrome for best compatibility

### Performance Tips 💡

#### For Better Voice Quality
- Use a quiet environment
- Speak clearly at normal pace
- Use an external microphone if available
- Ensure stable internet connection

#### For Better Performance
- Close unnecessary browser tabs
- Use Chrome for best WebRTC support
- Ensure 8GB+ RAM for optimal performance
- Use wired internet when possible

## Advanced Usage 🎯

### Development Commands
```bash
# Install dependencies
npm run install:all

# Start development servers
npm run dev

# Build for production
npm run build

# Run tests
npm run test

# Type checking
npm run type-check

# Linting
npm run lint

# Clean build files
npm run clean
```

### Environment Variables
```env
# Backend (.env)
OPENAI_API_KEY=your_api_key_here
PORT=3001
NODE_ENV=development
DATABASE_PATH=./data/medical_intake.db
FRONTEND_URL=http://localhost:5173
```

### Project Structure
```
Pre-Consultation/
├── README.md              # Comprehensive documentation
├── QUICKSTART.md          # This file
├── REQUIREMENTS.md        # System requirements
├── setup.sh              # Automated setup script
├── package.json           # Root package configuration
├── backend/               # Node.js backend
│   ├── src/
│   │   ├── server.ts      # Express server
│   │   ├── realtime.ts    # OpenAI integration
│   │   └── database.ts    # SQLite database
│   └── package.json
└── frontend/              # React frontend
    ├── src/
    │   ├── App.tsx        # Main application
    │   ├── pages/         # Application pages
    │   └── components/    # UI components
    └── package.json
```

## Next Steps 📚

### Learn More
- **README.md**: Complete setup and usage guide
- **REQUIREMENTS.md**: Detailed system requirements
- **TECHNICAL_DOCUMENTATION.md**: Technical architecture details

### Get Support
- **GitHub Issues**: Report bugs or request features
- **GitHub Discussions**: Community support and questions
- **Documentation**: Comprehensive guides and API references

### Customize
- **Styling**: Modify `frontend/src/App.css` for custom themes
- **Configuration**: Adjust settings in environment files
- **Features**: Extend functionality in React components

## Success! 🎉

You now have a fully functional Medical Intake Voice Agent with:

✅ **Real-time voice conversations** with AI
✅ **Professional medical interface** 
✅ **Complete session management**
✅ **Transcript viewing and export**
✅ **Red flag detection and alerts**
✅ **Responsive design** for all devices

**Happy voice processing!** 🎙️✨

---

*Need help? Check the full README.md or create an issue on GitHub.*