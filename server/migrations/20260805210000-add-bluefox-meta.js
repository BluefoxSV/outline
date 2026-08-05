"use strict";

/** Bluefox: internal TMP-002-equivalent metadata (Status, MkDocs Path, …). */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("documents", "bluefoxMeta", {
      type: Sequelize.JSONB,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("documents", "bluefoxMeta");
  },
};
