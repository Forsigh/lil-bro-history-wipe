## 1.5.4

Nothing changes in the app itself. This release is the safety net for the next ones: a backup file from an old build is now fed to the current importer by a test, the zips, the versions table and the changelog are checked against each other on every run, and the shape of everything saved is frozen so a renamed setting fails the build instead of quietly losing someone's list. The live probe also stopped pinning a version number, which used to break it on every bump.

