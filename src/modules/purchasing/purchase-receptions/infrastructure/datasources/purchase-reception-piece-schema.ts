import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';

const migrations = [{ id: 'purchase_reception_pieces', sql: `
  CREATE SEQUENCE tuvansa.purchase_reception_piece_ids START WITH 7972000000000 MAXVALUE 7972999999999;
  CREATE TABLE tuvansa.purchase_reception_piece_counters (
    company_id integer PRIMARY KEY CHECK(company_id=1), last_number integer NOT NULL
  );
  CREATE TABLE tuvansa.purchase_reception_piece_lines (
    company_id integer NOT NULL CHECK(company_id=1), receipt_id bigint NOT NULL, receipt_number varchar(13) NOT NULL,
    line_id bigint NOT NULL, product_id bigint NOT NULL, base_quantity numeric(18,3) NOT NULL,
    base_pieces text NOT NULL, pieces varchar(24000) NOT NULL, revision integer NOT NULL CHECK(revision>0),
    PRIMARY KEY(company_id,receipt_id,line_id)
  );
  CREATE TABLE tuvansa.purchase_reception_pieces (
    id bigint PRIMARY KEY, company_id integer NOT NULL CHECK(company_id=1), receipt_id bigint NOT NULL,
    receipt_number varchar(13) NOT NULL, line_id bigint, product_id bigint NOT NULL, legacy_piece_id bigint,
    original_serial varchar(30) NOT NULL, serial varchar(30) NOT NULL, quantity numeric(18,3) NOT NULL,
    request_key uuid, fingerprint char(64), piece jsonb NOT NULL, retired boolean NOT NULL DEFAULT false,
    UNIQUE(company_id,request_key), UNIQUE(legacy_piece_id),
    CHECK((legacy_piece_id IS NULL AND line_id IS NOT NULL AND quantity>0 AND request_key IS NOT NULL AND fingerprint IS NOT NULL)
       OR (legacy_piece_id IS NOT NULL AND line_id IS NULL AND request_key IS NULL AND fingerprint IS NULL))
  );
  CREATE UNIQUE INDEX purchase_reception_piece_serial ON tuvansa.purchase_reception_pieces(serial) WHERE NOT retired;
  CREATE INDEX purchase_reception_piece_document ON tuvansa.purchase_reception_pieces(company_id,receipt_id);
  CREATE INDEX purchase_reception_piece_product ON tuvansa.purchase_reception_pieces(product_id);
` }];

const transferMigration = { id: 'purchase_reception_piece_order_origin', sql: `
  ALTER TABLE tuvansa.purchase_reception_pieces
    ADD COLUMN source_order_id bigint,
    ADD COLUMN source_order_number varchar(15),
    DROP CONSTRAINT purchase_reception_pieces_check,
    ADD CONSTRAINT purchase_reception_piece_origin CHECK (
      (source_order_id IS NULL AND source_order_number IS NULL AND
        ((legacy_piece_id IS NULL AND line_id IS NOT NULL AND quantity>0 AND request_key IS NOT NULL AND fingerprint IS NOT NULL)
          OR (legacy_piece_id IS NOT NULL AND line_id IS NULL AND request_key IS NULL AND fingerprint IS NULL)))
      OR (source_order_id IS NOT NULL AND source_order_number IS NOT NULL AND legacy_piece_id IS NULL
        AND line_id IS NULL AND request_key IS NULL AND fingerprint IS NULL)
    );
` };

export const ensurePurchaseReceptionPiecesSchema = (client: PostgresClient) => migratePostgres(client, migrations);
export const ensurePurchaseReceptionPieceTransfersSchema = (client: PostgresClient) => migratePostgres(client, [...migrations, transferMigration]);
