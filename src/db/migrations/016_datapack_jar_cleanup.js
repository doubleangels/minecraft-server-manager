'use strict';

// Datapacks and resource packs are only ever .zip archives. Earlier builds of
// the "add by URL / search" flow could resolve a Modrinth project to its
// Fabric/Quilt "mod-wrapped" .jar (a separate version, version_number like
// "1.5.2+mod") and record it as a datapack/resourcepack overlay. A .jar in
// world/datapacks/ or resourcepacks/ is ignored by the game, so the file was
// dead weight and its row lingered as a phantom "Missing" entry - typically
// right next to the real .zip the user had added by hand. Drop those rows; the
// shared library_files copy stays and is swept later if nothing references it.
// A genuine datapack/resource pack is never a .jar, so this can't hit one.

function up(db) {
  db.run(
    `DELETE FROM server_content
      WHERE managed_by = 'overlay'
        AND kind IN ('datapack', 'resourcepack')
        AND lower(filename) LIKE '%.jar'`
  );
}

module.exports = { up };
