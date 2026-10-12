; Added to electron-builder's NSIS installer (package.json > build > nsis > include).
;
; Keeps the shortcuts, and the taskbar pin, when installing a new version over an old one.
; With allowToChangeInstallationDirectory, electron-builder only keeps them for updates started
; by electron-updater (--updated); an installer run by hand had the old version uninstall them,
; which also unpins the app from the taskbar. The folder page is already in place when this
; header is read, so only the shortcut handling changes. (Updates reuse the folder of the
; installed version: InstallLocation in the registry.)
!macro customHeader
  !ifdef allowToChangeInstallationDirectory
    !undef allowToChangeInstallationDirectory
  !endif
!macroend
