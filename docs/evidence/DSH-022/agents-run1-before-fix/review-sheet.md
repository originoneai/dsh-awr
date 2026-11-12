# Takeover review sheet: dsh001-fixture

- Result: `needs_organization`
- Run: `40dd19b298d1`
- Commits in the project: 34

## Goals and work items the takeover made

Trace each one to a README line or a commit, or mark it invented or wrong.

| Item | Kind | Traced to (README line / commit) | Verdict (supported / invented / wrong) |
| --- | --- | --- | --- |
| `- id: subagent-collection` | work-ledger.yaml | | |
| `title: Claude Code Subagents Collection` | work-ledger.yaml | | |

## Recent history

```
d9e72d1 Add ios-developer and ui-ux-designer agents
545c69c Update README.md with simplified model naming convention
04e78f8 Add model specification to php-pro agent
f6fbf2c Merge pull request #20 from sbharth1/main
a0d0c1f fix frontmatter model declaration with simple aliases
fb3bd33 Add MIT License
005d7fa Fix prompt-engineer to display actual prompts (#4)
e8d8e43 Fix merge conflict marker in README.md
6cbe310 Add model customization to all subagents (#7)
29f56ed Merge pull request #10 from yenaryenar/main
eb8de39 Merge branch 'main' into main
f003ef1 Update README.md
746047a Merge pull request #12 from t34wrj/patch-1
ffebc4b Update README.md to reflect addition of legal advisor
599caf9 Add php-pro subagent for idiomatic PHP programming.
dbc4041 Merge pull request #2 from DanielWTE/add-legal-advisor-agent
3fe00d6 Add legal-advisor subagent
c5f65be Merge pull request #1 from igor-sadchenko/main
979472d Add cpp-pro subagent for idiomatic C++ programming.
067312b Add 6 new business and specialized subagents
bdc0578 Add Commands repository reference to workflows section
7bf45cf Add mlops-engineer subagent and update README
6ae6bce Add database-admin subagent and update README
40d2687 Add network-engineer subagent and update README
cca2c18 Add error-detective subagent
5226a5f Add error-detective subagent to README
8238f91 Update README with new agents and fix terraform-specialist filename
b38b1d1 add agents for rust-pro, c-pro, sql-pro, javascript-pro, terraform-specialist
5423007 add agents for rust-pro, c-pro, sql-pro, javascript-pro, terraform-specialist
6da4a17 readme updates
```

## README, first 60 lines

```
# Claude Code Subagents Collection

A comprehensive collection of specialized AI subagents for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), designed to enhance development workflows with domain-specific expertise.

## Overview

This repository contains 48 specialized subagents that extend Claude Code's capabilities. Each subagent is an expert in a specific domain, automatically invoked based on context or explicitly called when needed. All agents are configured with specific Claude models based on task complexity for optimal performance and cost-effectiveness.

## Available Subagents

### Development & Architecture
- **[backend-architect](backend-architect.md)** - Design RESTful APIs, microservice boundaries, and database schemas
- **[frontend-developer](frontend-developer.md)** - Build React components, implement responsive layouts, and handle client-side state management
- **[ui-ux-designer](ui-ux-designer.md)** - Create interface designs, wireframes, and design systems
- **[mobile-developer](mobile-developer.md)** - Develop React Native or Flutter apps with native integrations
- **[graphql-architect](graphql-architect.md)** - Design GraphQL schemas, resolvers, and federation
- **[architect-reviewer](architect-review.md)** - Reviews code changes for architectural consistency and patterns

### Language Specialists
- **[python-pro](python-pro.md)** - Write idiomatic Python code with advanced features and optimizations
- **[golang-pro](golang-pro.md)** - Write idiomatic Go code with goroutines, channels, and interfaces
- **[rust-pro](rust-pro.md)** - Write idiomatic Rust with ownership patterns, lifetimes, and trait implementations
- **[c-pro](c-pro.md)** - Write efficient C code with proper memory management and system calls
- **[cpp-pro](cpp-pro.md)** - Write idiomatic C++ code with modern features, RAII, smart pointers, and STL algorithms
- **[javascript-pro](javascript-pro.md)** - Master modern JavaScript with ES6+, async patterns, and Node.js APIs
- **[php-pro](php-pro.md)** - Write idiomatic PHP code with modern features and performance optimizations
- **[ios-developer](ios-developer.md)** - Develop native iOS applications with Swift/SwiftUI
- **[sql-pro](sql-pro.md)** - Write complex SQL queries, optimize execution plans, and design normalized schemas

### Infrastructure & Operations
- **[devops-troubleshooter](devops-troubleshooter.md)** - Debug production issues, analyze logs, and fix deployment failures
- **[deployment-engineer](deployment-engineer.md)** - Configure CI/CD pipelines, Docker containers, and cloud deployments
- **[cloud-architect](cloud-architect.md)** - Design AWS/Azure/GCP infrastructure and optimize cloud costs
- **[database-optimizer](database-optimizer.md)** - Optimize SQL queries, design efficient indexes, and handle database migrations
- **[database-admin](database-admin.md)** - Manage database operations, backups, replication, and monitoring
- **[terraform-specialist](terraform-specialist.md)** - Write advanced Terraform modules, manage state files, and implement IaC best practices
- **[incident-responder](incident-responder.md)** - Handles production incidents with urgency and precision
- **[network-engineer](network-engineer.md)** - Debug network connectivity, configure load balancers, and analyze traffic patterns
- **[dx-optimizer](dx-optimizer.md)** - Developer Experience specialist that improves tooling, setup, and workflows

### Quality & Security
- **[code-reviewer](code-reviewer.md)** - Expert code review for quality, security, and maintainability
- **[security-auditor](security-auditor.md)** - Review code for vulnerabilities and ensure OWASP compliance
- **[test-automator](test-automator.md)** - Create comprehensive test suites with unit, integration, and e2e tests
- **[performance-engineer](performance-engineer.md)** - Profile applications, optimize bottlenecks, and implement caching strategies
- **[debugger](debugger.md)** - Debugging specialist for errors, test failures, and unexpected behavior
- **[error-detective](error-detective.md)** - Search logs and codebases for error patterns, stack traces, and anomalies
- **[search-specialist](search-specialist.md)** - Expert web researcher using advanced search techniques and synthesis

### Data & AI
- **[data-scientist](data-scientist.md)** - Data analysis expert for SQL queries, BigQuery operations, and data insights
- **[data-engineer](data-engineer.md)** - Build ETL pipelines, data warehouses, and streaming architectures
- **[ai-engineer](ai-engineer.md)** - Build LLM applications, RAG systems, and prompt pipelines
- **[ml-engineer](ml-engineer.md)** - Implement ML pipelines, model serving, and feature engineering
- **[mlops-engineer](mlops-engineer.md)** - Build ML pipelines, experiment tracking, and model registries
- **[prompt-engineer](prompt-engineer.md)** - Optimizes prompts for LLMs and AI systems

### Specialized Domains
- **[api-documenter](api-documenter.md)** - Create OpenAPI/Swagger specs and write developer documentation
- **[payment-integration](payment-integration.md)** - Integrate Stripe, PayPal, and payment processors
```
