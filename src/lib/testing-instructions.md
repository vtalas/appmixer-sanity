# Testing Instructions

## Overview

This document provides guidance on how to test Appmixer connectors and their components during sanity checks.

Instance for sanity check testing: https://my.clientio.appmixer.cloud/  
username: test@appmixer.ai   
Test flow naming convention: `Sanity check - {connector name}`  
Github repository for issues: https://github.com/appmixer/appmixer-components  
Github issue conventions:
 - title: `{connector.name}.{component.name}: brief description of the issue`, for example `airtable.NewRecord: trigger is not firing`
 - label: `sanity-check #{sanity check number}`, for example `sanity-check #1`

## Testing Connectors

### Before You Start

1. Ensure you have the latast version of the connector installed.
2. Test flow name follows the naming conventions.

### Testing Process

1. **Authentication**: Verify the connector can authenticate successfully
2. **Basic Operations**: Test core CRUD operations if applicable
3. **Error Handling**: Verify proper error messages for invalid inputs

## Testing Components

### Actions

- Test with valid inputs first
- Test edge cases (empty values, special characters)
- Verify output format 

### Triggers

- Verify trigger fires on expected events
- Check polling frequency if applicable

## Status Guidelines

| Status | When to Use |
|--------|-------------|
| **OK** | Component works as expected |
| **Fail** | Component has issues that need fixing |
| **Pending** | Not yet tested |
| **Blocked** | Cannot test due to external factors |

## Reporting Issues

If you find a bug:

1. Set the component status to **Fail**
2. Add a GitHub issue link in the component details.  
3. Include steps to reproduce in the issue

