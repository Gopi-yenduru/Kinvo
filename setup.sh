#!/bin/bash

# Medical Intake Voice Agent - Automated Setup Script
# This script sets up the entire application on macOS

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Emojis for better UX
ROCKET="🚀"
CHECK="✅"
WARNING="⚠️"
ERROR="❌"
INFO="ℹ️"
MEDICAL="🏥"

echo -e "${PURPLE}${MEDICAL} Medical Intake Voice Agent - Setup Script${NC}"
echo -e "${CYAN}================================================${NC}"
echo ""

# Function to print colored output
print_status() {
    echo -e "${GREEN}${CHECK} $1${NC}"
}

print_info() {
    echo -e "${BLUE}${INFO} $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}${WARNING} $1${NC}"
}

print_error() {
    echo -e "${RED}${ERROR} $1${NC}"
}

print_header() {
    echo -e "${PURPLE}${ROCKET} $1${NC}"
}

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to check macOS version
check_macos_version() {
    print_header "Checking macOS Version"
    
    if [[ "$OSTYPE" != "darwin"* ]]; then
        print_error "This script is designed for macOS only."
        exit 1
    fi
    
    macos_version=$(sw_vers -productVersion)
    print_info "macOS Version: $macos_version"
    
    # Check if macOS version is 10.15 or later
    if [[ $(echo "$macos_version" | cut -d. -f1) -lt 10 ]] || 
       [[ $(echo "$macos_version" | cut -d. -f1) -eq 10 && $(echo "$macos_version" | cut -d. -f2) -lt 15 ]]; then
        print_error "macOS 10.15 (Catalina) or later is required."
        exit 1
    fi
    
    print_status "macOS version is compatible"
    echo ""
}

# Function to check and install Node.js
check_nodejs() {
    print_header "Checking Node.js Installation"
    
    if command_exists node; then
        node_version=$(node --version | sed 's/v//')
        print_info "Node.js Version: $node_version"
        
        # Check if Node.js version is 18 or later
        major_version=$(echo "$node_version" | cut -d. -f1)
        if [[ $major_version -lt 18 ]]; then
            print_warning "Node.js 18.0.0 or later is required. Current version: $node_version"
            install_nodejs
        else
            print_status "Node.js version is compatible"
        fi
    else
        print_warning "Node.js is not installed"
        install_nodejs
    fi
    echo ""
}

# Function to install Node.js
install_nodejs() {
    print_info "Installing Node.js..."
    
    if command_exists brew; then
        print_info "Using Homebrew to install Node.js"
        brew install node
    else
        print_warning "Homebrew not found. Please install Node.js manually:"
        print_info "1. Visit: https://nodejs.org/en/download/"
        print_info "2. Download the macOS installer"
        print_info "3. Run the installer"
        print_info "4. Restart your terminal"
        print_info "5. Run this script again"
        exit 1
    fi
    
    print_status "Node.js installed successfully"
}

# Function to check npm
check_npm() {
    print_header "Checking npm Installation"
    
    if command_exists npm; then
        npm_version=$(npm --version)
        print_info "npm Version: $npm_version"
        print_status "npm is available"
    else
        print_error "npm is not available. Please reinstall Node.js."
        exit 1
    fi
    echo ""
}

# Function to install dependencies
install_dependencies() {
    print_header "Installing Project Dependencies"
    
    # Install backend dependencies
    print_info "Installing backend dependencies..."
    cd backend
    npm install
    print_status "Backend dependencies installed"
    
    # Install frontend dependencies
    print_info "Installing frontend dependencies..."
    cd ../frontend
    npm install
    print_status "Frontend dependencies installed"
    
    cd ..
    echo ""
}

# Function to setup environment
setup_environment() {
    print_header "Setting Up Environment Configuration"
    
    # Copy .env.example to .env if it doesn't exist
    if [[ ! -f "backend/.env" ]]; then
        print_info "Creating environment configuration file..."
        cp backend/.env.example backend/.env
        print_status "Environment file created: backend/.env"
    else
        print_info "Environment file already exists: backend/.env"
    fi
    
    # Check if OpenAI API key is set
    if grep -q "your_openai_api_key_here" backend/.env; then
        print_warning "OpenAI API key needs to be configured!"
        echo ""
        print_info "Please follow these steps:"
        print_info "1. Visit: https://platform.openai.com/api-keys"
        print_info "2. Create an account or sign in"
        print_info "3. Generate a new API key"
        print_info "4. Edit backend/.env file and replace 'your_openai_api_key_here' with your actual API key"
        echo ""
        print_warning "The application will not work without a valid OpenAI API key!"
    else
        print_status "Environment configuration appears to be set up"
    fi
    echo ""
}

# Function to setup database
setup_database() {
    print_header "Setting Up Database Configuration"

    print_info "This application uses SQL Server (MSSQL) instead of SQLite."
    print_info "Please ensure you have:"
    echo ""
    print_info "1. Access to a SQL Server instance (local or cloud)"
    print_info "2. Database user credentials with read/write permissions"
    print_info "3. Network connectivity to the SQL Server"
    echo ""
    print_warning "Database connection details are configured in: backend/src/dbConfig.ts"
    print_info "Update the connection parameters in dbConfig.ts for your environment."
    echo ""

    # Check if dbConfig.ts exists and is properly configured
    if [[ -f "backend/src/dbConfig.ts" ]]; then
        print_status "Database configuration file found: backend/src/dbConfig.ts"
        print_info "Please verify the connection details in this file match your SQL Server setup."
    else
        print_error "Database configuration file not found: backend/src/dbConfig.ts"
        exit 1
    fi
    echo ""
}

# Function to verify installation
verify_installation() {
    print_header "Verifying Installation"
    
    # Check if all required files exist
    required_files=(
        "backend/package.json"
        "backend/src/server.ts"
        "backend/src/realtime.ts"
        "backend/src/database.ts"
        "frontend/package.json"
        "frontend/src/App.tsx"
        "frontend/src/main.tsx"
        "backend/.env"
    )
    
    for file in "${required_files[@]}"; do
        if [[ -f "$file" ]]; then
            print_status "$file exists"
        else
            print_error "$file is missing"
            exit 1
        fi
    done
    
    echo ""
}

# Function to show next steps
show_next_steps() {
    print_header "Setup Complete! Next Steps:"
    echo ""
    print_info "1. Configure your OpenAI API key (if not done already):"
    echo -e "   ${CYAN}nano backend/.env${NC}"
    echo ""
    print_info "2. Start the backend server:"
    echo -e "   ${CYAN}cd backend && npm run dev${NC}"
    echo ""
    print_info "3. In a new terminal, start the frontend:"
    echo -e "   ${CYAN}cd frontend && npm run dev${NC}"
    echo ""
    print_info "4. Open your browser and navigate to:"
    echo -e "   ${CYAN}http://localhost:5173${NC}"
    echo ""
    print_status "Your Medical Intake Voice Agent is ready to use!"
    echo ""
    print_info "For detailed usage instructions, see README.md"
    echo ""
}

# Function to offer to start servers
offer_start_servers() {
    echo -e "${YELLOW}Would you like to start the servers now? (y/n)${NC}"
    read -r response
    
    if [[ "$response" =~ ^[Yy]$ ]]; then
        start_servers
    else
        print_info "You can start the servers manually using the commands shown above."
    fi
}

# Function to start servers
start_servers() {
    print_header "Starting Application Servers"
    
    # Check if OpenAI API key is configured
    if grep -q "your_openai_api_key_here" backend/.env; then
        print_error "Cannot start servers: OpenAI API key is not configured!"
        print_info "Please edit backend/.env and add your OpenAI API key first."
        return 1
    fi
    
    print_info "Starting backend server..."
    print_warning "This will open new terminal windows for the servers."
    print_info "Keep both terminal windows open while using the application."
    
    # Start backend in new terminal
    osascript -e "tell application \"Terminal\" to do script \"cd '$PWD/backend' && npm run dev\""
    
    # Wait a moment for backend to start
    sleep 3
    
    # Start frontend in new terminal
    osascript -e "tell application \"Terminal\" to do script \"cd '$PWD/frontend' && npm run dev\""
    
    print_status "Servers are starting in new terminal windows"
    print_info "The application will be available at: http://localhost:5173"
    
    # Wait a moment then try to open browser
    sleep 5
    print_info "Opening application in your default browser..."
    open "http://localhost:5173"
}

# Main execution
main() {
    echo -e "${MEDICAL} ${PURPLE}Welcome to the Medical Intake Voice Agent Setup!${NC}"
    echo ""
    print_info "This script will set up everything you need to run the application."
    echo ""
    
    # Run all setup steps
    check_macos_version
    check_nodejs
    check_npm
    install_dependencies
    setup_environment
    setup_database
    verify_installation
    show_next_steps
    offer_start_servers
    
    echo ""
    print_status "Setup completed successfully!"
    echo -e "${PURPLE}${MEDICAL} Thank you for using Medical Intake Voice Agent!${NC}"
}

# Run main function
main "$@"