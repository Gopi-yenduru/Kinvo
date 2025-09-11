# System Requirements

## Hardware Requirements

### Minimum Requirements
- **Processor**: Intel Core i5 or Apple M1 chip
- **Memory**: 4GB RAM
- **Storage**: 2GB free disk space
- **Audio**: Built-in microphone and speakers/headphones
- **Network**: Broadband internet connection (minimum 1 Mbps)

### Recommended Requirements
- **Processor**: Intel Core i7 or Apple M1 Pro/Max chip
- **Memory**: 8GB RAM or more
- **Storage**: 5GB free disk space (SSD preferred)
- **Audio**: External USB microphone for better voice quality
- **Network**: High-speed internet connection (5+ Mbps)

## Software Requirements

### Operating System
- **macOS**: 10.15 (Catalina) or later
- **Supported versions**: 
  - macOS 10.15 Catalina
  - macOS 11.0 Big Sur
  - macOS 12.0 Monterey
  - macOS 13.0 Ventura
  - macOS 14.0 Sonoma
  - macOS 15.0 Sequoia

### Development Environment
- **Node.js**: 18.0.0 or later (LTS recommended)
- **npm**: 8.0.0 or later (comes with Node.js)
- **Git**: 2.0 or later (for version control)

### Browser Compatibility
- **Chrome**: 90 or later (recommended for best WebRTC support)
- **Safari**: 14 or later
- **Firefox**: 88 or later
- **Edge**: 90 or later

## API Requirements

### OpenAI API
- **Account**: OpenAI Platform account required
- **API Key**: Valid OpenAI API key with Realtime API access
- **Billing**: Active billing account (Realtime API is a paid service)
- **Rate Limits**: Sufficient rate limits for your usage

### Network Requirements
- **Ports**: 
  - 3001 (backend server)
  - 5173 (frontend development server)
  - 443 (HTTPS for OpenAI API)
- **Firewall**: Allow outbound connections to OpenAI API
- **WebSocket**: WebSocket support required for real-time communication

## Development Tools (Optional)

### Code Editors
- **VS Code**: Recommended with TypeScript and React extensions
- **WebStorm**: Full-featured IDE for JavaScript/TypeScript
- **Sublime Text**: Lightweight editor with syntax highlighting

### Package Managers
- **npm**: Default package manager (included with Node.js)
- **yarn**: Alternative package manager (optional)
- **pnpm**: Fast, disk space efficient package manager (optional)

### Version Control
- **Git**: Required for source code management
- **GitHub Desktop**: GUI for Git operations (optional)

## Performance Considerations

### Memory Usage
- **Backend**: ~100-200MB RAM
- **Frontend**: ~50-100MB RAM
- **Browser**: ~200-500MB RAM per tab
- **Total**: ~500MB-1GB RAM during operation

### CPU Usage
- **Audio Processing**: Moderate CPU usage during voice sessions
- **Real-time Processing**: Higher CPU usage during active conversations
- **Background**: Minimal CPU usage when idle

### Network Usage
- **Audio Streaming**: ~64kbps upload during voice input
- **API Calls**: Variable based on conversation length
- **WebSocket**: Persistent connection with minimal overhead

## Security Requirements

### API Security
- **HTTPS**: All API communications use HTTPS encryption
- **API Keys**: Secure storage of OpenAI API keys
- **Environment Variables**: Sensitive data stored in environment files

### Browser Security
- **Microphone Permissions**: Browser microphone access required
- **CORS**: Cross-Origin Resource Sharing properly configured
- **Content Security Policy**: Secure content loading policies

### Data Privacy
- **Local Storage**: Session data stored locally in SQLite
- **No Cloud Storage**: Conversations not stored in external services
- **OpenAI Policy**: Audio data processed by OpenAI (see their privacy policy)

## Troubleshooting Common Issues

### Node.js Issues
- **Version Conflicts**: Use Node Version Manager (nvm) for multiple versions
- **Permission Errors**: Avoid using sudo with npm
- **Path Issues**: Ensure Node.js is in system PATH

### Audio Issues
- **Microphone Access**: Grant browser permissions for microphone
- **Audio Quality**: Use external microphone for better results
- **Playback Issues**: Check system audio settings and browser audio

### Network Issues
- **Firewall**: Ensure required ports are not blocked
- **Proxy**: Configure proxy settings if behind corporate firewall
- **DNS**: Use reliable DNS servers (8.8.8.8, 1.1.1.1)

### API Issues
- **Rate Limits**: Monitor OpenAI API usage and limits
- **Billing**: Ensure active billing account for API access
- **Realtime Access**: Verify Realtime API access (may require waitlist)

## Installation Verification

### Quick Health Check
```bash
# Check Node.js version
node --version  # Should be 18.0.0+

# Check npm version
npm --version   # Should be 8.0.0+

# Check Git version
git --version   # Should be 2.0+

# Test internet connectivity
curl -I https://api.openai.com  # Should return 200 OK
```

### System Information
```bash
# Check macOS version
sw_vers -productVersion

# Check available memory
system_profiler SPHardwareDataType | grep Memory

# Check available disk space
df -h

# Check CPU information
sysctl -n machdep.cpu.brand_string
```

## Support and Resources

### Documentation
- **README.md**: Main setup and usage guide
- **TECHNICAL_DOCUMENTATION.md**: Detailed technical information
- **API Documentation**: OpenAI Realtime API documentation

### Community
- **GitHub Issues**: Report bugs and request features
- **GitHub Discussions**: Community support and questions
- **Stack Overflow**: General development questions

### Professional Support
- **Enterprise**: Contact for enterprise deployment support
- **Custom Development**: Available for custom modifications
- **Training**: Available for team training and onboarding