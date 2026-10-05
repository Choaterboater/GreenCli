// Live show commands on Windows: the named pipe's locks (mcp_live.rs has the
// rest). The pipe lets in this Windows user only, twice over:
// - its security rules have one entry, "this user may use it", so Windows
//   refuses everyone else (other users, and remote computers: those are
//   refused as well, see create_pipe);
// - each program that comes in is checked again by the user of its process.
// It is always made new (never joined), so a pipe someone made first under
// the same name is never used. The file that names it, with the secret, gets
// the same one rule (write_only_user).

use std::io::{self, Write};
use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use tokio::net::windows::named_pipe::{NamedPipeServer, PipeMode, ServerOptions};
use windows_sys::Win32::Foundation::{GENERIC_ALL, GENERIC_READ, GENERIC_WRITE, HANDLE};
use windows_sys::Win32::Security::{
    AddAccessAllowedAce, GetLengthSid, GetTokenInformation, InitializeAcl,
    InitializeSecurityDescriptor, IsValidSid, SetKernelObjectSecurity, SetSecurityDescriptorDacl,
    TokenUser, ACCESS_ALLOWED_ACE, ACL, ACL_REVISION, DACL_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
    SECURITY_DESCRIPTOR, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::System::Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId};
use windows_sys::Win32::System::SystemServices::SECURITY_DESCRIPTOR_REVISION;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// Room for the requests and answers, so a 4 KB request never waits to be sent.
const BUFFER: u32 = 64 * 1024;

/// A Windows user (a copy of its SID).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserSid(Vec<u32>);

impl UserSid {
    fn as_psid(&self) -> *mut core::ffi::c_void {
        self.0.as_ptr() as *mut _
    }
}

fn check(ok: i32) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// The user a token belongs to.
fn token_user(token: &OwnedHandle) -> io::Result<UserSid> {
    let handle = token.as_raw_handle() as HANDLE;
    let mut len = 0u32;
    // SAFETY: a size query; nothing is written with a null buffer.
    unsafe { GetTokenInformation(handle, TokenUser, std::ptr::null_mut(), 0, &mut len) };
    if (len as usize) < size_of::<TOKEN_USER>() {
        return Err(io::Error::last_os_error());
    }
    let mut buf = vec![0u64; (len as usize).div_ceil(8)];
    // SAFETY: `buf` holds `len` bytes, aligned for TOKEN_USER.
    check(unsafe {
        GetTokenInformation(handle, TokenUser, buf.as_mut_ptr().cast(), len, &mut len)
    })?;
    // SAFETY: filled in by GetTokenInformation above; the SID it points to
    // lives inside `buf`, checked before it is read.
    unsafe {
        let sid = (*(buf.as_ptr() as *const TOKEN_USER)).User.Sid;
        check(IsValidSid(sid))?;
        let n = GetLengthSid(sid) as usize;
        if !n.is_multiple_of(4) {
            return Err(io::Error::other("unexpected SID length"));
        }
        let mut out = vec![0u32; n / 4];
        std::ptr::copy_nonoverlapping(sid as *const u8, out.as_mut_ptr() as *mut u8, n);
        Ok(UserSid(out))
    }
}

/// The user GreenCLI runs as.
pub fn current_user() -> io::Result<UserSid> {
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: GetCurrentProcess is a constant handle; `token` is closed by OwnedHandle.
    check(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) })?;
    // SAFETY: a token handle just opened, owned from here on.
    let token = unsafe { OwnedHandle::from_raw_handle(token as _) };
    token_user(&token)
}

/// The program on the other end of `pipe`: its process id and its user, read
/// from its process. None when that can't be read.
pub fn client_user(pipe: &NamedPipeServer) -> Option<(u32, UserSid)> {
    let mut pid = 0u32;
    // SAFETY: the pipe handle is open for the call.
    check(unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle() as HANDLE, &mut pid) }).ok()?;
    Some((pid, process_user(pid)?))
}

/// The user of the program that made the pipe `pipe` (a client's handle to
/// it). None when that can't be read.
pub fn pipe_server_user(pipe: &impl AsRawHandle) -> Option<UserSid> {
    let mut pid = 0u32;
    // SAFETY: the pipe handle is open for the call.
    check(unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle() as HANDLE, &mut pid) }).ok()?;
    process_user(pid)
}

/// The user process `pid` runs as. None when that can't be read.
fn process_user(pid: u32) -> Option<UserSid> {
    // SAFETY: a process handle (null on failure), owned from here on.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return None;
    }
    // SAFETY: just opened above.
    let process = unsafe { OwnedHandle::from_raw_handle(process as _) };
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: `process` is open; `token` is closed by OwnedHandle.
    check(unsafe { OpenProcessToken(process.as_raw_handle() as HANDLE, TOKEN_QUERY, &mut token) })
        .ok()?;
    // SAFETY: a token handle just opened.
    let token = unsafe { OwnedHandle::from_raw_handle(token as _) };
    token_user(&token).ok()
}

/// Security rules that let `user` in, and no one else. The parts point at
/// each other, so they live together.
struct OnlyUser {
    _acl: Vec<u32>,
    _sd: Box<SECURITY_DESCRIPTOR>,
    attrs: SECURITY_ATTRIBUTES,
}

impl OnlyUser {
    fn new(user: &UserSid) -> io::Result<Self> {
        let sid_len = user.0.len() * 4;
        let acl_len =
            size_of::<ACL>() + size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>() + sid_len;
        let mut acl = vec![0u32; acl_len.div_ceil(4)];
        let acl_ptr = acl.as_mut_ptr() as *mut ACL;
        // SAFETY: `acl` holds `acl_len` bytes, u32-aligned; the SID is valid
        // (read from a token) and copied into the ACL.
        unsafe {
            check(InitializeAcl(acl_ptr, (acl.len() * 4) as u32, ACL_REVISION))?;
            check(AddAccessAllowedAce(
                acl_ptr,
                ACL_REVISION,
                GENERIC_ALL,
                user.as_psid(),
            ))?;
        }
        // SAFETY: an all-zero SECURITY_DESCRIPTOR is plain data; it is set up
        // by InitializeSecurityDescriptor before use.
        let mut sd: Box<SECURITY_DESCRIPTOR> = Box::new(unsafe { std::mem::zeroed() });
        let sd_ptr = &mut *sd as *mut SECURITY_DESCRIPTOR as PSECURITY_DESCRIPTOR;
        // SAFETY: `sd` and `acl` stay alive (and in place, on the heap) as
        // long as `attrs`, which points at them.
        unsafe {
            check(InitializeSecurityDescriptor(
                sd_ptr,
                SECURITY_DESCRIPTOR_REVISION,
            ))?;
            check(SetSecurityDescriptorDacl(sd_ptr, 1, acl_ptr, 0))?;
        }
        let attrs = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd_ptr,
            bInheritHandle: 0,
        };
        Ok(Self {
            _acl: acl,
            _sd: sd,
            attrs,
        })
    }
}

/// Write `bytes` to a new file at `path` whose one rule lets `user` in, and
/// no one else (nothing taken from the folder): the 0600 of Windows.
pub fn write_only_user(path: &std::path::Path, bytes: &[u8], user: &UserSid) -> io::Result<()> {
    use std::os::windows::fs::OpenOptionsExt;
    /// May change the file's rules.
    const WRITE_DAC: u32 = 0x0004_0000;
    let only = OnlyUser::new(user)?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .access_mode(GENERIC_READ | GENERIC_WRITE | WRITE_DAC)
        .open(path)?;
    // SAFETY: the file handle is open; the descriptor lives in `only`.
    check(unsafe {
        SetKernelObjectSecurity(
            file.as_raw_handle() as HANDLE,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            only.attrs.lpSecurityDescriptor,
        )
    })?;
    file.write_all(bytes)?;
    file.flush()
}

/// Tests: a user other than this one (Local System, S-1-5-18).
#[cfg(test)]
pub fn local_system() -> UserSid {
    UserSid(vec![
        u32::from_le_bytes([1, 1, 0, 0]),
        u32::from_le_bytes([0, 0, 0, 5]),
        18,
    ])
}

/// `\\.\pipe\<name>`: a pipe on this computer.
pub fn pipe_path(name: &str) -> String {
    format!(r"\\.\pipe\{name}")
}

/// One door of the pipe `name`, for `user` only, never for other computers.
/// `first`: the pipe must not exist yet (a pipe made first by anyone else
/// gives "access denied" instead). Must run inside a tokio runtime.
pub fn create_pipe(name: &str, user: &UserSid, first: bool) -> io::Result<NamedPipeServer> {
    let mut only = OnlyUser::new(user)?;
    let mut options = ServerOptions::new();
    options
        .first_pipe_instance(first)
        .reject_remote_clients(true)
        .access_inbound(true)
        .access_outbound(true)
        .pipe_mode(PipeMode::Byte)
        .in_buffer_size(BUFFER)
        .out_buffer_size(BUFFER);
    // SAFETY: `only.attrs` is a valid SECURITY_ATTRIBUTES whose parts live
    // until after this call returns.
    unsafe {
        options.create_with_security_attributes_raw(
            pipe_path(name),
            &mut only.attrs as *mut SECURITY_ATTRIBUTES as *mut core::ffi::c_void,
        )
    }
}

/// Tests: the pipe's security rules as (allowed?, user), read through an
/// open handle to it.
#[cfg(test)]
pub fn pipe_rules(handle: &impl AsRawHandle) -> io::Result<Vec<(bool, UserSid)>> {
    use windows_sys::Win32::Security::{
        GetAce, GetKernelObjectSecurity, GetSecurityDescriptorDacl, ACE_HEADER,
        DACL_SECURITY_INFORMATION,
    };
    use windows_sys::Win32::System::SystemServices::ACCESS_ALLOWED_ACE_TYPE;
    let h = handle.as_raw_handle() as HANDLE;
    let mut len = 0u32;
    // SAFETY: a size query.
    unsafe {
        GetKernelObjectSecurity(
            h,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            0,
            &mut len,
        )
    };
    let mut buf = vec![0u64; (len as usize).div_ceil(8).max(1)];
    // SAFETY: `buf` holds `len` bytes.
    check(unsafe {
        GetKernelObjectSecurity(
            h,
            DACL_SECURITY_INFORMATION,
            buf.as_mut_ptr().cast(),
            len,
            &mut len,
        )
    })?;
    let (mut present, mut defaulted) = (0, 0);
    let mut acl: *mut ACL = std::ptr::null_mut();
    // SAFETY: `buf` holds the descriptor just read; `acl` points into it.
    check(unsafe {
        GetSecurityDescriptorDacl(
            buf.as_mut_ptr().cast(),
            &mut present,
            &mut acl,
            &mut defaulted,
        )
    })?;
    if present == 0 || acl.is_null() {
        return Err(io::Error::other("no DACL: everyone may use the pipe"));
    }
    let mut out = Vec::new();
    // SAFETY: `acl` is valid while `buf` lives; each ACE is read in bounds.
    unsafe {
        for i in 0..u32::from((*acl).AceCount) {
            let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
            check(GetAce(acl, i, &mut ace))?;
            let header = &*(ace as *const ACE_HEADER);
            let allowed = u32::from(header.AceType) == ACCESS_ALLOWED_ACE_TYPE;
            let sid = &(*(ace as *const ACCESS_ALLOWED_ACE)).SidStart as *const u32 as *mut _;
            let n = GetLengthSid(sid) as usize;
            let mut copy = vec![0u32; n / 4];
            std::ptr::copy_nonoverlapping(sid as *const u8, copy.as_mut_ptr() as *mut u8, n);
            out.push((allowed, UserSid(copy)));
        }
    }
    Ok(out)
}
