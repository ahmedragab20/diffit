#!/usr/bin/env bash

# skills.sh - Premium CLI for managing, validating, and publishing agent skills to skills.sh

set -e

# Color codes for beautiful UI
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Helper for printing styled headers
print_header() {
    echo -e "\n${BOLD}${BLUE}=== $1 ===${NC}\n"
}

# Helper for printing success messages
print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

# Helper for printing warnings
print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

# Helper for printing errors
print_error() {
    echo -e "${RED}✗ $1${NC}"
}

# Show usage instructions
show_usage() {
    echo -e "${BOLD}diffing Agent Skills Manager (${CYAN}skills.sh${NC}${BOLD})${NC}"
    echo -e "A premium developer utility to validate, install, and publish skills to skills.sh"
    echo
    echo -e "${BOLD}Usage:${NC} ./skills.sh <command> [options]"
    echo
    echo -e "${BOLD}Commands:${NC}"
    echo -e "  ${GREEN}list${NC}       List all local skills in this repository"
    echo -e "  ${GREEN}validate${NC}   Validate the structure and YAML frontmatter of the skills"
    echo -e "  ${GREEN}install${NC}    Install all local skills to all detected AI coding agents"
    echo -e "  ${GREEN}publish${NC}    Publish/Register all skills to the skills.sh registry"
    echo
    echo -e "${BOLD}Options:${NC}"
    echo -e "  -h, --help  Show this help message"
    echo
}

# Check if skills directory exists
check_skills_dir() {
    if [ ! -d "skills" ]; then
        print_error "The 'skills' directory could not be found."
        exit 1
    fi
}

# The `skills` installer treats every skills directory it detects as an install
# target - including this repository's own sources - and replaces them with
# symlinks back into .agents/skills. Snapshot before installing, repair after.
SKILLS_SNAPSHOT=""

snapshot_skills() {
    SKILLS_SNAPSHOT=$(mktemp -d "${TMPDIR:-/tmp}/diffing-skills.XXXXXX")
    cp -R skills/. "$SKILLS_SNAPSHOT/"
}

restore_skills() {
    [ -n "$SKILLS_SNAPSHOT" ] && [ -d "$SKILLS_SNAPSHOT" ] || return 0
    local restored=0
    local link name
    for link in skills/*; do
        [ -L "$link" ] || continue
        name=$(basename "$link")
        [ -d "$SKILLS_SNAPSHOT/$name" ] || continue
        rm -f "$link"
        cp -R "$SKILLS_SNAPSHOT/$name" "skills/$name"
        restored=$((restored + 1))
    done
    rm -rf "$SKILLS_SNAPSHOT"
    SKILLS_SNAPSHOT=""
    if [ "$restored" -gt 0 ]; then
        print_warning "Restored $restored skill source(s) the installer replaced with symlinks."
    fi
}

# Command: List skills
cmd_list() {
    check_skills_dir
    print_header "Local Agent Skills"
    
    local found=0
    for dir in skills/*; do
        if [ -d "$dir" ] && [ -f "$dir/SKILL.md" ]; then
            found=1
            # Extract name and description from frontmatter
            local name=$(grep -E "^name:" "$dir/SKILL.md" | head -n 1 | sed 's/name:[[:space:]]*//' | tr -d '"' | tr -d "'")
            local desc=$(grep -E "^description:" "$dir/SKILL.md" | head -n 1 | sed 's/description:[[:space:]]*//' | tr -d '"' | tr -d "'")
            
            # If description is empty or multiline marker, try to get it more reliably
            if [[ "$desc" == ">"* ]] || [[ -z "$desc" ]]; then
                desc="Detailed agent code review workflow skill"
            fi
            
            echo -e "  ${BOLD}${CYAN}$name${NC} - $desc"
            echo -e "    ${YELLOW}Path:${NC} $dir/SKILL.md"
            echo
        fi
    done
    
    if [ $found -eq 0 ]; then
        print_warning "No skills found under the skills/ directory."
    fi
}

# Command: Validate skills
cmd_validate() {
    check_skills_dir
    print_header "Validating Agent Skills"
    
    local overall_success=0
    for dir in skills/*; do
        if [ -d "$dir" ] && [ -f "$dir/SKILL.md" ]; then
            local skill_name=$(basename "$dir")
            echo -e "Analyzing ${BOLD}$skill_name${NC}..."
            
            local errors=()
            
            # Read frontmatter
            local content=$(cat "$dir/SKILL.md")
            
            # Check frontmatter block exists
            if [[ ! "$content" =~ ^---[[:space:]]*$'\n' ]]; then
                errors+=("Missing leading YAML frontmatter separator '---'")
            fi
            
            # Check required fields
            local name=$(grep -E "^name:" "$dir/SKILL.md" | head -n 1 | sed 's/name:[[:space:]]*//' | tr -d '"' | tr -d "'")
            local desc=$(grep -E "^description:" "$dir/SKILL.md" | head -n 1 | sed 's/description:[[:space:]]*//')
            local user_invocable=$(grep -E "^user_invocable:" "$dir/SKILL.md" | head -n 1 | sed 's/user_invocable:[[:space:]]*//')
            
            if [ -z "$name" ]; then
                errors+=("Missing 'name' field in frontmatter")
            elif [ "$name" != "$skill_name" ]; then
                errors+=("Frontmatter 'name' ($name) does not match folder name ($skill_name)")
            fi
            
            if [ -z "$desc" ]; then
                errors+=("Missing 'description' field in frontmatter")
            fi
            
            if [ -z "$user_invocable" ]; then
                errors+=("Missing 'user_invocable' field in frontmatter")
            fi
            
            if [ ${#errors[@]} -eq 0 ]; then
                print_success "$skill_name is perfectly valid!"
            else
                print_error "$skill_name has validation errors:"
                for err in "${errors[@]}"; do
                    echo -e "    - $err"
                done
                overall_success=1
            fi
            echo
        fi
    done
    
    if [ $overall_success -eq 0 ]; then
        print_success "All skills validated successfully!"
        return 0
    else
        print_error "Some skills failed validation. Please fix errors before proceeding."
        return 1
    fi
}

# Command: Install skills
cmd_install() {
    # Run validation first
    cmd_validate || exit 1
    
    print_header "Installing Skills Locally"
    echo -e "Installing local skills to all detected coding agents via ${CYAN}npx skills add${NC}..."
    snapshot_skills
    trap restore_skills EXIT
    npx skills add ./skills --copy --all
    restore_skills
    trap - EXIT
}

# Command: Publish skills
cmd_publish() {
    cmd_validate || exit 1
    
    print_header "Publishing to skills.sh Registry"
    
    # 1. Get git remote repository
    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        print_error "Not inside a git repository. Pushing to GitHub is required to register with skills.sh."
        exit 1
    fi
    
    local remote_url=$(git remote get-url origin 2>/dev/null || echo "")
    if [ -z "$remote_url" ]; then
        print_error "No git remote 'origin' configured. A public GitHub repository is required to register with skills.sh."
        exit 1
    fi
    
    # Parse slug from remote URL (e.g. git@github.com:owner/repo.git or https://github.com/owner/repo.git)
    local slug=""
    if [[ "$remote_url" =~ github.com[:/]([^/]+/[^.]+)(\.git)? ]]; then
        slug="${BASH_REMATCH[1]}"
    fi
    
    if [ -z "$slug" ]; then
        print_error "Could not parse repository slug from remote URL: $remote_url"
        exit 1
    fi
    
    echo -e "Detected public GitHub repository slug: ${BOLD}${CYAN}$slug${NC}"
    
    # 2. Check for uncommitted changes
    if ! git diff --quiet || ! git diff --cached --quiet; then
        print_warning "You have uncommitted changes in your repository."
        print_warning "Skills.sh registers skills by reading your remote GitHub repository."
        echo -ne "${YELLOW}Do you want to commit and push changes now? (y/N): ${NC}"
        read -r commit_ans
        if [[ "$commit_ans" =~ ^[Yy]$ ]]; then
            echo -ne "${CYAN}Enter commit message: ${NC}"
            read -r commit_msg
            if [ -z "$commit_msg" ]; then
                commit_msg="Update agent skills"
            fi
            git add skills/
            git commit -m "$commit_msg"
            echo -e "${GREEN}Committed skills changes!${NC}"
        fi
    fi
    
    # 3. Prompt pushing to origin
    echo -e "Pushing local changes to origin..."
    local current_branch=$(git branch --show-current)
    if git push origin "$current_branch"; then
        print_success "Pushed successfully to GitHub!"
    else
        print_warning "Failed to push to GitHub automatically. Make sure your repository is public and pushed to origin."
    fi
    
    # 4. Trigger telemetry on skills.sh
    echo
    echo -e "Registering/Refreshing skills in ${BOLD}skills.sh${NC} registry..."
    echo -e "Running telemetry registration via: ${CYAN}npx skills add $slug --all${NC}"
    echo
    
    snapshot_skills
    trap restore_skills EXIT
    if npx skills add "$slug" --all; then
        echo
        print_success "Successfully published and registered all skills to skills.sh!"
        echo -e "Other developers can now install your skills via: ${BOLD}npx skills add $slug${NC}"
    else
        print_error "Telemetry registration failed. You may need to manually run 'npx skills add $slug' once."
    fi
    restore_skills
    trap - EXIT
}

# Main command dispatcher
main() {
    if [ $# -eq 0 ]; then
        show_usage
        exit 0
    fi
    
    case "$1" in
        list)
            cmd_list
            ;;
        validate)
            cmd_validate
            ;;
        install)
            cmd_install
            ;;
        publish)
            cmd_publish
            ;;
        -h|--help)
            show_usage
            ;;
        *)
            print_error "Unknown command: $1"
            show_usage
            exit 1
            ;;
    esac
}

main "$@"
