Run one command with administrator privileges when the requested operation cannot be completed with the normal user account.

The command, arguments, working directory, and environment are passed without shell interpolation. The tool asks for the administrator password in a masked side-channel prompt; never put a password, token, or other secret in command arguments or environment values. The password is cached only in process memory for a short period and is not included in the session transcript, tool arguments, output, or logs.
