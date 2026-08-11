using System;

internal static class UpgradeNoop
{
    [STAThread]
    private static int Main()
    {
        // The 1.0.0 uninstaller displays an interactive data-deletion prompt even
        // during a silent upgrade. The repair installer temporarily points the
        // old uninstall registration at this helper so electron-builder can
        // continue with an in-place update while keeping user data and project
        // files untouched.
        return 0;
    }
}
