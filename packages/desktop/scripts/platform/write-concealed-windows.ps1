# Cross-process concealed-marker writer for Windows (M1 CI verification).
#
# Writes a synthetic exclusion marker to the REAL system clipboard using the
# genuine Win32 clipboard API, from a process that is NOT Electron. This is what
# makes the CI test meaningful: Cliptide's Linux result only ever proved that one
# Electron process could read back a type it had written itself.
#
# This is deliberately NOT a simulation. It calls RegisterClipboardFormat and
# SetClipboardData exactly as any native Windows application does.
#
# IMPORTANT SCOPE LIMIT: proving Electron can see a marker written this way does
# NOT prove that 1Password, Bitwarden, or Keeper set this same marker. That
# remains a manual test on a real desktop.
#
# Privacy: the payload is a fixed synthetic string, never printed.

$ErrorActionPreference = 'Stop'

$MarkerFormat   = 'ExcludeClipboardContentFromMonitorProcessing'
$SyntheticValue = 'cliptide-ci-synthetic-not-a-real-secret'

Add-Type -Language CSharp @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class CliptideClipWriter
{
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool OpenClipboard(IntPtr hWndNewOwner);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern uint RegisterClipboardFormat(string lpszFormat);

    [DllImport("kernel32.dll")]
    static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);
    [DllImport("kernel32.dll")]
    static extern IntPtr GlobalLock(IntPtr hMem);
    [DllImport("kernel32.dll")]
    static extern bool GlobalUnlock(IntPtr hMem);

    const uint GMEM_MOVEABLE = 0x0002;
    const uint CF_UNICODETEXT = 13;

    // The clipboard takes ownership of the handle once SetClipboardData
    // succeeds, so these are deliberately not freed here.
    static IntPtr AllocBytes(byte[] data)
    {
        IntPtr handle = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)(uint)data.Length);
        if (handle == IntPtr.Zero) return IntPtr.Zero;
        IntPtr ptr = GlobalLock(handle);
        if (ptr == IntPtr.Zero) return IntPtr.Zero;
        Marshal.Copy(data, 0, ptr, data.Length);
        GlobalUnlock(handle);
        return handle;
    }

    /// <summary>0 = success. Non-zero codes identify which Win32 call failed.</summary>
    public static int Write(string text, string markerFormat, out uint registeredFormat)
    {
        registeredFormat = 0;

        if (!OpenClipboard(IntPtr.Zero)) return 10;
        try
        {
            if (!EmptyClipboard()) return 11;

            byte[] textBytes = Encoding.Unicode.GetBytes(text + "\0");
            IntPtr textHandle = AllocBytes(textBytes);
            if (textHandle == IntPtr.Zero) return 12;
            if (SetClipboardData(CF_UNICODETEXT, textHandle) == IntPtr.Zero) return 13;

            registeredFormat = RegisterClipboardFormat(markerFormat);
            if (registeredFormat == 0) return 14;

            IntPtr markerHandle = AllocBytes(new byte[] { 1 });
            if (markerHandle == IntPtr.Zero) return 15;
            if (SetClipboardData(registeredFormat, markerHandle) == IntPtr.Zero) return 16;

            return 0;
        }
        finally
        {
            CloseClipboard();
        }
    }
}
'@

[uint32]$registered = 0
$code = [CliptideClipWriter]::Write($SyntheticValue, $MarkerFormat, [ref]$registered)

# Report only booleans, names, and identifiers. Never the value.
Write-Output "writer_pid=$PID"
Write-Output "marker_format=$MarkerFormat"
Write-Output "registered_format_id=$registered"
Write-Output "payload_length=$($SyntheticValue.Length)"
Write-Output "write_result_code=$code"

exit $code
