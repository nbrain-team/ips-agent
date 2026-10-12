-- 045: SAP S/4HANA Cloud (IPS's system of record from the August 1, 2026
-- cutover) in schema sap_s4, plus sap.gl_lines: one general ledger across
-- SAP B1 (before the cutover) and S/4HANA (from it).
--
-- The nine data tables mirror VistaVu's read-only CDS views
-- (YY1_EXT_<view>_READ, Communication Arrangement YY1_CUSTOM_INTEGRATION)
-- column for column; their DDL and column comments are generated from the
-- views' $metadata by scripts/sap-s4-schema-gen.js. Loaded by
-- agentic/services/sapS4Sync.js.

CREATE SCHEMA IF NOT EXISTS sap_s4;

-- Which S/4 tenant the rows came from. sap.gl_lines only includes S/4 rows
-- when environment = 'production'.
CREATE TABLE IF NOT EXISTS sap_s4.tenant (
  id          BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  host        TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'production')),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE sap_s4.tenant IS 'The S/4HANA tenant sap_s4 was loaded from. environment = test means the rows are VistaVu test postings, not IPS''s books.';

CREATE TABLE IF NOT EXISTS sap_s4.sync_state (
  entity         TEXT PRIMARY KEY,
  last_run_at    TIMESTAMPTZ,
  last_full_at   TIMESTAMPTZ,
  last_status    TEXT,               -- ok | error | not_authorized
  last_error     TEXT,
  rows_in_window INTEGER,            -- rows replaced by the last run (all rows on a full refresh)
  schema_drift   JSONB               -- {added, removed}: fields SAP changed since sapS4Schema.js was generated
);

CREATE TABLE IF NOT EXISTS sap_s4.customers (
  customer                                 TEXT NOT NULL,
  customer_name                            TEXT,
  customer_full_name                       TEXT,
  bp_customer_name                         TEXT,
  creation_date                            DATE,
  customer_account_group                   TEXT,
  posting_is_blocked                       BOOLEAN,
  delivery_is_blocked                      TEXT,
  tax_jurisdiction                         TEXT,
  tax_number_type                          TEXT,
  supplier                                 TEXT,
  customer_corporate_group                 TEXT,
  country                                  TEXT,
  city_name                                TEXT,
  postal_code                              TEXT,
  street_name                              TEXT,
  deletion_indicator                       BOOLEAN,
  language                                 TEXT,
  county                                   TEXT,
  city_code                                TEXT,
  industry_type                            TEXT,
  tw_collv_billing_is_supported            TEXT,
  is_consumer                              BOOLEAN,
  payment_is_blocked_for_customer          BOOLEAN,
  is_sales_prospect                        TEXT,
  district_name                            TEXT,
  reconciliation_account                   TEXT,
  payment_terms                            TEXT,
  company_code                             TEXT,
  accounting_clerk                         TEXT,
  customer_account_note                    TEXT,
  house_bank                               TEXT,
  payt_advice_is_sentby_edi                BOOLEAN,
  item_is_to_be_paid_separately            BOOLEAN,
  apar_tolerance_group                     TEXT,
  payment_blocking_reason                  TEXT,
  alternative_payer_account                TEXT,
  customer_head_office                     TEXT,
  authorization_group                      TEXT,
  deletion_indicator_1                     BOOLEAN,
  supplier_release_group                   TEXT,
  personnel_number                         TEXT,
  buying_group_account_number              TEXT,
  payment_reason                           TEXT,
  payment_clearing_group                   TEXT,
  deletion_is_blocked                      BOOLEAN,
  synced_at                                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer)
);
COMMENT ON COLUMN sap_s4.customers.customer IS 'Customer Number (SAP Customer)';
COMMENT ON COLUMN sap_s4.customers.customer_name IS 'Name of Customer (SAP CustomerName)';
COMMENT ON COLUMN sap_s4.customers.customer_full_name IS 'Customer Full Name (SAP CustomerFullName)';
COMMENT ON COLUMN sap_s4.customers.bp_customer_name IS 'Customer Name (SAP BPCustomerName)';
COMMENT ON COLUMN sap_s4.customers.creation_date IS 'Record Created On (SAP CreationDate)';
COMMENT ON COLUMN sap_s4.customers.customer_account_group IS 'Customer Account Group (SAP CustomerAccountGroup)';
COMMENT ON COLUMN sap_s4.customers.posting_is_blocked IS 'Central Posting Block (SAP PostingIsBlocked)';
COMMENT ON COLUMN sap_s4.customers.delivery_is_blocked IS 'Central delivery block for the customer (SAP DeliveryIsBlocked)';
COMMENT ON COLUMN sap_s4.customers.tax_jurisdiction IS 'Tax Jurisdiction (SAP TaxJurisdiction)';
COMMENT ON COLUMN sap_s4.customers.tax_number_type IS 'Tax Number Type (SAP TaxNumberType)';
COMMENT ON COLUMN sap_s4.customers.supplier IS 'Account Number of Supplier (SAP Supplier)';
COMMENT ON COLUMN sap_s4.customers.customer_corporate_group IS 'Group Key (SAP CustomerCorporateGroup)';
COMMENT ON COLUMN sap_s4.customers.country IS 'Country/Region Key (SAP Country)';
COMMENT ON COLUMN sap_s4.customers.city_name IS 'City (SAP CityName)';
COMMENT ON COLUMN sap_s4.customers.postal_code IS 'Postal Code (SAP PostalCode)';
COMMENT ON COLUMN sap_s4.customers.street_name IS 'Street and House Number (SAP StreetName)';
COMMENT ON COLUMN sap_s4.customers.deletion_indicator IS 'Central Deletion Flag for Master Record (SAP DeletionIndicator)';
COMMENT ON COLUMN sap_s4.customers.language IS 'Language Key (SAP Language)';
COMMENT ON COLUMN sap_s4.customers.county IS 'County Code (SAP County)';
COMMENT ON COLUMN sap_s4.customers.city_code IS 'City Code (SAP CityCode)';
COMMENT ON COLUMN sap_s4.customers.industry_type IS 'Type of Industry (SAP IndustryType)';
COMMENT ON COLUMN sap_s4.customers.tw_collv_billing_is_supported IS 'Consolidated Invoicing for Taiwan (SAP TW_CollvBillingIsSupported)';
COMMENT ON COLUMN sap_s4.customers.is_consumer IS 'Indicator: Consumer (SAP IsConsumer)';
COMMENT ON COLUMN sap_s4.customers.payment_is_blocked_for_customer IS 'Payment Block (SAP PaymentIsBlockedForCustomer)';
COMMENT ON COLUMN sap_s4.customers.is_sales_prospect IS 'Indicator: Sales prospect (SAP IsSalesProspect)';
COMMENT ON COLUMN sap_s4.customers.district_name IS 'District (SAP DistrictName)';
COMMENT ON COLUMN sap_s4.customers.reconciliation_account IS 'Reconciliation Account in General Ledger (SAP ReconciliationAccount)';
COMMENT ON COLUMN sap_s4.customers.payment_terms IS 'Key for Terms of Payment (SAP PaymentTerms)';
COMMENT ON COLUMN sap_s4.customers.company_code IS 'Company Code (SAP CompanyCode)';
COMMENT ON COLUMN sap_s4.customers.accounting_clerk IS 'Accounting Clerk Abbreviation (SAP AccountingClerk)';
COMMENT ON COLUMN sap_s4.customers.customer_account_note IS 'Memo (SAP CustomerAccountNote)';
COMMENT ON COLUMN sap_s4.customers.house_bank IS 'Short Key for a House Bank (SAP HouseBank)';
COMMENT ON COLUMN sap_s4.customers.payt_advice_is_sentby_edi IS 'Indicator: Send Payment Advices by EDI (SAP PaytAdviceIsSentbyEDI)';
COMMENT ON COLUMN sap_s4.customers.item_is_to_be_paid_separately IS 'Indicator: Pay All Items Separately? (SAP ItemIsToBePaidSeparately)';
COMMENT ON COLUMN sap_s4.customers.apar_tolerance_group IS 'Tolerance Group for Business Partner/G/L Account (SAP APARToleranceGroup)';
COMMENT ON COLUMN sap_s4.customers.payment_blocking_reason IS 'Block Key for Payment (SAP PaymentBlockingReason)';
COMMENT ON COLUMN sap_s4.customers.alternative_payer_account IS 'Account number of an alternative payer (SAP AlternativePayerAccount)';
COMMENT ON COLUMN sap_s4.customers.customer_head_office IS 'Head Office Account Number (in branch accounts) (SAP CustomerHeadOffice)';
COMMENT ON COLUMN sap_s4.customers.authorization_group IS 'Authorization Group (SAP AuthorizationGroup)';
COMMENT ON COLUMN sap_s4.customers.deletion_indicator_1 IS 'Deletion Flag for Master Record (Company Code Level) (SAP DeletionIndicator_1)';
COMMENT ON COLUMN sap_s4.customers.supplier_release_group IS 'Release Approval Group (SAP SupplierReleaseGroup)';
COMMENT ON COLUMN sap_s4.customers.personnel_number IS 'Personnel Number (SAP PersonnelNumber)';
COMMENT ON COLUMN sap_s4.customers.buying_group_account_number IS 'Account Number of Buying Group (SAP BuyingGroupAccountNumber)';
COMMENT ON COLUMN sap_s4.customers.payment_reason IS 'Payment Reason (SAP PaymentReason)';
COMMENT ON COLUMN sap_s4.customers.payment_clearing_group IS 'Payment Clearing Group ID (SAP PaymentClearingGroup)';
COMMENT ON COLUMN sap_s4.customers.deletion_is_blocked IS 'Deletion Block for Master Record (Company Code Level) (SAP DeletionIsBlocked)';

CREATE TABLE IF NOT EXISTS sap_s4.suppliers (
  supplier                                 TEXT NOT NULL,
  supplier_name                            TEXT,
  supplier_account_group                   TEXT,
  supplier_full_name                       TEXT,
  bp_supplier_name                         TEXT,
  region                                   TEXT,
  city_name                                TEXT,
  postal_code                              TEXT,
  street_name                              TEXT,
  country                                  TEXT,
  supplier_language                        TEXT,
  reference_account_group                  TEXT,
  posting_is_blocked                       BOOLEAN,
  deletion_indicator                       BOOLEAN,
  customer                                 TEXT,
  synced_at                                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (supplier)
);
COMMENT ON COLUMN sap_s4.suppliers.supplier IS 'Account Number of Supplier (SAP Supplier)';
COMMENT ON COLUMN sap_s4.suppliers.supplier_name IS 'Name of Supplier (SAP SupplierName)';
COMMENT ON COLUMN sap_s4.suppliers.supplier_account_group IS 'Supplier Account Group (SAP SupplierAccountGroup)';
COMMENT ON COLUMN sap_s4.suppliers.supplier_full_name IS 'Supplier Full Name (SAP SupplierFullName)';
COMMENT ON COLUMN sap_s4.suppliers.bp_supplier_name IS 'Supplier Name (SAP BPSupplierName)';
COMMENT ON COLUMN sap_s4.suppliers.region IS 'Region (State, Province, County) (SAP Region)';
COMMENT ON COLUMN sap_s4.suppliers.city_name IS 'City (SAP CityName)';
COMMENT ON COLUMN sap_s4.suppliers.postal_code IS 'Postal Code (SAP PostalCode)';
COMMENT ON COLUMN sap_s4.suppliers.street_name IS 'Street and House Number (SAP StreetName)';
COMMENT ON COLUMN sap_s4.suppliers.country IS 'Country/Region Key (SAP Country)';
COMMENT ON COLUMN sap_s4.suppliers.supplier_language IS 'Language Key (SAP SupplierLanguage)';
COMMENT ON COLUMN sap_s4.suppliers.reference_account_group IS 'Reference Account Group for One-Time Account (Vendor) (SAP ReferenceAccountGroup)';
COMMENT ON COLUMN sap_s4.suppliers.posting_is_blocked IS 'Central Posting Block (SAP PostingIsBlocked)';
COMMENT ON COLUMN sap_s4.suppliers.deletion_indicator IS 'Central Deletion Flag for Master Record (SAP DeletionIndicator)';
COMMENT ON COLUMN sap_s4.suppliers.customer IS 'Customer Number (SAP Customer)';

CREATE TABLE IF NOT EXISTS sap_s4.ship_to_partners (
  customer                                 TEXT NOT NULL,
  sales_organization                       TEXT NOT NULL,
  distribution_channel                     TEXT NOT NULL,
  division                                 TEXT NOT NULL,
  partner_counter                          TEXT NOT NULL,
  partner_function                         TEXT NOT NULL,
  default_partner                          BOOLEAN,
  supplier                                 TEXT,
  personnel_number                         TEXT,
  contact_person                           TEXT,
  partner_function_type                    TEXT,
  bp_customer_number                       TEXT,
  customer_partner_description             TEXT,
  division_1                               TEXT,
  distribution_channel_1                   TEXT,
  language                                 TEXT,
  sales_organization_1                     TEXT,
  customer_1                               TEXT,
  customer_name                            TEXT,
  synced_at                                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer, sales_organization, distribution_channel, division, partner_counter, partner_function)
);
COMMENT ON COLUMN sap_s4.ship_to_partners.customer IS 'Customer Number (SAP Customer)';
COMMENT ON COLUMN sap_s4.ship_to_partners.sales_organization IS 'Sales Organization (SAP SalesOrganization)';
COMMENT ON COLUMN sap_s4.ship_to_partners.distribution_channel IS 'Distribution Channel (SAP DistributionChannel)';
COMMENT ON COLUMN sap_s4.ship_to_partners.division IS 'Division (SAP Division)';
COMMENT ON COLUMN sap_s4.ship_to_partners.partner_counter IS 'Partner counter (SAP PartnerCounter)';
COMMENT ON COLUMN sap_s4.ship_to_partners.partner_function IS 'Partner Function (SAP PartnerFunction)';
COMMENT ON COLUMN sap_s4.ship_to_partners.default_partner IS 'Default Partner (SAP DefaultPartner)';
COMMENT ON COLUMN sap_s4.ship_to_partners.supplier IS 'Account Number of Supplier (SAP Supplier)';
COMMENT ON COLUMN sap_s4.ship_to_partners.personnel_number IS 'Personnel Number (SAP PersonnelNumber)';
COMMENT ON COLUMN sap_s4.ship_to_partners.contact_person IS 'Number of Contact Person (SAP ContactPerson)';
COMMENT ON COLUMN sap_s4.ship_to_partners.partner_function_type IS 'Type of partner number (SAP PartnerFunctionType)';
COMMENT ON COLUMN sap_s4.ship_to_partners.bp_customer_number IS 'Account Number of Supplier (SAP BPCustomerNumber)';
COMMENT ON COLUMN sap_s4.ship_to_partners.customer_partner_description IS 'Cust.-Specif. Descr. of Business Partner (Plant, Stor. Loc.) (SAP CustomerPartnerDescription)';
COMMENT ON COLUMN sap_s4.ship_to_partners.division_1 IS 'Division (SAP Division_1)';
COMMENT ON COLUMN sap_s4.ship_to_partners.distribution_channel_1 IS 'Distribution Channel (SAP DistributionChannel_1)';
COMMENT ON COLUMN sap_s4.ship_to_partners.language IS 'Language Key (SAP Language)';
COMMENT ON COLUMN sap_s4.ship_to_partners.sales_organization_1 IS 'Sales Organization (SAP SalesOrganization_1)';
COMMENT ON COLUMN sap_s4.ship_to_partners.customer_1 IS 'Customer Number (SAP Customer_1)';
COMMENT ON COLUMN sap_s4.ship_to_partners.customer_name IS 'Name of Customer (SAP CustomerName)';

CREATE TABLE IF NOT EXISTS sap_s4.products (
  product                                  TEXT NOT NULL,
  product_external_id                      TEXT,
  product_type                             TEXT,
  base_unit                                TEXT,
  product_group                            TEXT,
  fieldvu_related                          TEXT,
  language                                 TEXT,
  product_name                             TEXT,
  creation_date                            DATE,
  manufacturer_number                      TEXT,
  last_change_date                         DATE,
  gross_weight                             NUMERIC(13,3),
  source_of_supply                         TEXT,
  country_of_origin                        TEXT,
  net_weight                               NUMERIC(13,3),
  division                                 TEXT,
  product_category                         TEXT,
  brand                                    TEXT,
  prod_no_in_gen_prod_in_prepack_prod      TEXT,
  last_change_time                         TIME,
  weight_unit                              TEXT,
  synced_at                                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product)
);
COMMENT ON COLUMN sap_s4.products.product IS 'Product (SAP Product)';
COMMENT ON COLUMN sap_s4.products.product_external_id IS 'External Representation of Material Number (SAP ProductExternalID)';
COMMENT ON COLUMN sap_s4.products.product_type IS 'Product Type (SAP ProductType)';
COMMENT ON COLUMN sap_s4.products.base_unit IS 'Base Unit of Measure (SAP BaseUnit)';
COMMENT ON COLUMN sap_s4.products.product_group IS 'Product Group (SAP ProductGroup)';
COMMENT ON COLUMN sap_s4.products.fieldvu_related IS 'FieldVu Related (SAP YY1_FieldVuRelated_PRD)';
COMMENT ON COLUMN sap_s4.products.language IS 'Language Key (SAP Language)';
COMMENT ON COLUMN sap_s4.products.product_name IS 'Product Description (SAP ProductName)';
COMMENT ON COLUMN sap_s4.products.creation_date IS 'Created On (SAP CreationDate)';
COMMENT ON COLUMN sap_s4.products.manufacturer_number IS 'Number of a Manufacturer (SAP ManufacturerNumber)';
COMMENT ON COLUMN sap_s4.products.last_change_date IS 'Date of Last Change (SAP LastChangeDate)';
COMMENT ON COLUMN sap_s4.products.gross_weight IS 'Gross Weight (SAP GrossWeight)';
COMMENT ON COLUMN sap_s4.products.source_of_supply IS 'Source of Supply (SAP SourceOfSupply)';
COMMENT ON COLUMN sap_s4.products.country_of_origin IS 'Country/Region of Origin of Material (Non-Preferential Ori.) (SAP CountryOfOrigin)';
COMMENT ON COLUMN sap_s4.products.net_weight IS 'Net Weight (SAP NetWeight)';
COMMENT ON COLUMN sap_s4.products.division IS 'Division (SAP Division)';
COMMENT ON COLUMN sap_s4.products.product_category IS 'Product Category (SAP ProductCategory)';
COMMENT ON COLUMN sap_s4.products.brand IS 'Brand (SAP Brand)';
COMMENT ON COLUMN sap_s4.products.prod_no_in_gen_prod_in_prepack_prod IS 'Material Number of the Generic Material in Prepack Materials (SAP ProdNoInGenProdInPrepackProd)';
COMMENT ON COLUMN sap_s4.products.last_change_time IS 'Time of Last Change (SAP LastChangeTime)';
COMMENT ON COLUMN sap_s4.products.weight_unit IS 'Unit of Weight (SAP WeightUnit)';

CREATE TABLE IF NOT EXISTS sap_s4.gl_accounts (
  chart_of_accounts                        TEXT NOT NULL,
  gl_account                               TEXT NOT NULL,
  is_balance_sheet_account                 BOOLEAN,
  gl_account_group                         TEXT,
  corporate_group_chart_of_accounts        TEXT,
  corporate_group_account                  TEXT,
  profit_loss_account_type                 TEXT,
  account_is_marked_for_deletion           BOOLEAN,
  account_is_blocked_for_creation          BOOLEAN,
  account_is_blocked_for_posting           BOOLEAN,
  partner_company                          TEXT,
  account_is_blocked_for_planning          BOOLEAN,
  functional_area                          TEXT,
  gl_account_type                          TEXT,
  gl_account_subtype                       TEXT,
  gl_account_external                      TEXT,
  bank_reconciliation_account              TEXT,
  is_profit_loss_account                   BOOLEAN,
  gl_account_name                          TEXT,
  gl_account_long_name                     TEXT,
  gl_account_name_language                 TEXT,
  synced_at                                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chart_of_accounts, gl_account)
);
COMMENT ON COLUMN sap_s4.gl_accounts.chart_of_accounts IS 'Chart of Accounts (SAP ChartOfAccounts)';
COMMENT ON COLUMN sap_s4.gl_accounts.gl_account IS 'G/L Account Number (SAP GLAccount)';
COMMENT ON COLUMN sap_s4.gl_accounts.is_balance_sheet_account IS 'Is Balance Sheet Account (SAP IsBalanceSheetAccount)';
COMMENT ON COLUMN sap_s4.gl_accounts.gl_account_group IS 'G/L Account Group (SAP GLAccountGroup)';
COMMENT ON COLUMN sap_s4.gl_accounts.corporate_group_chart_of_accounts IS 'Group Chart of Accts (SAP CorporateGroupChartOfAccounts)';
COMMENT ON COLUMN sap_s4.gl_accounts.corporate_group_account IS 'Group Account Number (SAP CorporateGroupAccount)';
COMMENT ON COLUMN sap_s4.gl_accounts.profit_loss_account_type IS 'P&L statement account type (SAP ProfitLossAccountType)';
COMMENT ON COLUMN sap_s4.gl_accounts.account_is_marked_for_deletion IS 'Indicator: Account Marked for Deletion? (SAP AccountIsMarkedForDeletion)';
COMMENT ON COLUMN sap_s4.gl_accounts.account_is_blocked_for_creation IS 'Indicator: Account Is Blocked for Creation ? (SAP AccountIsBlockedForCreation)';
COMMENT ON COLUMN sap_s4.gl_accounts.account_is_blocked_for_posting IS 'Indicator: Is Account Blocked for Posting? (SAP AccountIsBlockedForPosting)';
COMMENT ON COLUMN sap_s4.gl_accounts.partner_company IS 'Company ID of Trading Partner (SAP PartnerCompany)';
COMMENT ON COLUMN sap_s4.gl_accounts.account_is_blocked_for_planning IS 'Indicator: Account Blocked for Planning ? (SAP AccountIsBlockedForPlanning)';
COMMENT ON COLUMN sap_s4.gl_accounts.functional_area IS 'Functional Area (SAP FunctionalArea)';
COMMENT ON COLUMN sap_s4.gl_accounts.gl_account_type IS 'Type of a General Ledger Account (SAP GLAccountType)';
COMMENT ON COLUMN sap_s4.gl_accounts.gl_account_subtype IS 'Subtype of a GL Account (SAP GLAccountSubtype)';
COMMENT ON COLUMN sap_s4.gl_accounts.gl_account_external IS 'G/L Account Number (SAP GLAccountExternal)';
COMMENT ON COLUMN sap_s4.gl_accounts.bank_reconciliation_account IS 'Bank Reconciliation Account (SAP BankReconciliationAccount)';
COMMENT ON COLUMN sap_s4.gl_accounts.is_profit_loss_account IS 'Indicator: Account is a balance sheet account? (SAP IsProfitLossAccount)';
COMMENT ON COLUMN sap_s4.gl_accounts.gl_account_name IS 'G/L Account Name (SAP GLAccountName)';
COMMENT ON COLUMN sap_s4.gl_accounts.gl_account_long_name IS 'G/L Account Long Name (SAP GLAccountLongName)';
COMMENT ON COLUMN sap_s4.gl_accounts.gl_account_name_language IS 'Language Key (SAP GLAccountNameLanguage)';

CREATE TABLE IF NOT EXISTS sap_s4.cost_centers (
  controlling_area                         TEXT NOT NULL,
  cost_center                              TEXT NOT NULL,
  validity_end_date                        DATE NOT NULL,
  validity_start_date                      DATE,
  company_code                             TEXT,
  business_area                            TEXT,
  cost_center_category                     TEXT,
  cost_ctr_responsible_person_name         TEXT,
  cost_ctr_responsible_user                TEXT,
  cost_center_currency                     TEXT,
  costing_sheet                            TEXT,
  tax_jurisdiction                         TEXT,
  profit_center                            TEXT,
  plant                                    TEXT,
  logical_system                           TEXT,
  department                               TEXT,
  address_name                             TEXT,
  country                                  TEXT,
  city_name                                TEXT,
  district                                 TEXT,
  street_address_name                      TEXT,
  po_box                                   TEXT,
  region                                   TEXT,
  cost_center_language                     TEXT,
  cost_center_description                  TEXT,
  cost_center_name                         TEXT,
  synced_at                                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (controlling_area, cost_center, validity_end_date)
);
COMMENT ON COLUMN sap_s4.cost_centers.controlling_area IS 'Controlling Area (SAP ControllingArea)';
COMMENT ON COLUMN sap_s4.cost_centers.cost_center IS 'Cost Center (SAP CostCenter)';
COMMENT ON COLUMN sap_s4.cost_centers.validity_end_date IS 'Valid To Date (SAP ValidityEndDate)';
COMMENT ON COLUMN sap_s4.cost_centers.validity_start_date IS 'Valid-From Date (SAP ValidityStartDate)';
COMMENT ON COLUMN sap_s4.cost_centers.company_code IS 'Company Code (SAP CompanyCode)';
COMMENT ON COLUMN sap_s4.cost_centers.business_area IS 'Business Area (SAP BusinessArea)';
COMMENT ON COLUMN sap_s4.cost_centers.cost_center_category IS 'Cost Center Category (SAP CostCenterCategory)';
COMMENT ON COLUMN sap_s4.cost_centers.cost_ctr_responsible_person_name IS 'Person Responsible (SAP CostCtrResponsiblePersonName)';
COMMENT ON COLUMN sap_s4.cost_centers.cost_ctr_responsible_user IS 'User Responsible (SAP CostCtrResponsibleUser)';
COMMENT ON COLUMN sap_s4.cost_centers.cost_center_currency IS 'Currency Key (SAP CostCenterCurrency)';
COMMENT ON COLUMN sap_s4.cost_centers.costing_sheet IS 'Costing Sheet (SAP CostingSheet)';
COMMENT ON COLUMN sap_s4.cost_centers.tax_jurisdiction IS 'Tax Jurisdiction (SAP TaxJurisdiction)';
COMMENT ON COLUMN sap_s4.cost_centers.profit_center IS 'Profit Center (SAP ProfitCenter)';
COMMENT ON COLUMN sap_s4.cost_centers.plant IS 'Plant (SAP Plant)';
COMMENT ON COLUMN sap_s4.cost_centers.logical_system IS 'Logical System (SAP LogicalSystem)';
COMMENT ON COLUMN sap_s4.cost_centers.department IS 'Department (SAP Department)';
COMMENT ON COLUMN sap_s4.cost_centers.address_name IS 'Name (SAP AddressName)';
COMMENT ON COLUMN sap_s4.cost_centers.country IS 'Country/Region Key (SAP Country)';
COMMENT ON COLUMN sap_s4.cost_centers.city_name IS 'City (SAP CityName)';
COMMENT ON COLUMN sap_s4.cost_centers.district IS 'District (SAP District)';
COMMENT ON COLUMN sap_s4.cost_centers.street_address_name IS 'Street and House Number (SAP StreetAddressName)';
COMMENT ON COLUMN sap_s4.cost_centers.po_box IS 'PO Box (SAP POBox)';
COMMENT ON COLUMN sap_s4.cost_centers.region IS 'Region (State, Province, County) (SAP Region)';
COMMENT ON COLUMN sap_s4.cost_centers.cost_center_language IS 'Language Key (SAP CostCenterLanguage)';
COMMENT ON COLUMN sap_s4.cost_centers.cost_center_description IS 'Description of Cost Center (SAP CostCenterDescription)';
COMMENT ON COLUMN sap_s4.cost_centers.cost_center_name IS 'Cost Center Name (SAP CostCenterName)';

CREATE TABLE IF NOT EXISTS sap_s4.profit_centers (
  controlling_area                         TEXT NOT NULL,
  profit_center                            TEXT NOT NULL,
  validity_end_date                        DATE NOT NULL,
  profit_ctr_responsible_person_name       TEXT,
  company_code                             TEXT,
  profit_ctr_responsible_user              TEXT,
  validity_start_date                      DATE,
  department                               TEXT,
  profit_center_standard_hierarchy         TEXT,
  segment                                  TEXT,
  profit_center_is_blocked                 TEXT,
  formula_planning_template                TEXT,
  form_of_address                          TEXT,
  address_name                             TEXT,
  additional_name                          TEXT,
  profit_center_addr_name3                 TEXT,
  profit_center_addr_name4                 TEXT,
  street_address_name                      TEXT,
  po_box                                   TEXT,
  city_name                                TEXT,
  postal_code                              TEXT,
  po_box_postal_code                       TEXT,
  district                                 TEXT,
  country                                  TEXT,
  region                                   TEXT,
  tax_jurisdiction                         TEXT,
  language_1                               TEXT,
  phone_number1                            TEXT,
  phone_number2                            TEXT,
  telebox_number                           TEXT,
  telex_number                             TEXT,
  fax_number                               TEXT,
  teletex_number                           TEXT,
  data_communication_phone_number          TEXT,
  profit_center_printer_name               TEXT,
  profit_center_created_by_user            TEXT,
  profit_center_creation_date              DATE,
  logical_system                           TEXT,
  profit_center_name                       TEXT,
  profit_center_long_name                  TEXT,
  language                                 TEXT,
  synced_at                                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (controlling_area, profit_center, validity_end_date)
);
COMMENT ON COLUMN sap_s4.profit_centers.controlling_area IS 'Controlling Area (SAP ControllingArea)';
COMMENT ON COLUMN sap_s4.profit_centers.profit_center IS 'Profit Center (SAP ProfitCenter)';
COMMENT ON COLUMN sap_s4.profit_centers.validity_end_date IS 'Valid To Date (SAP ValidityEndDate)';
COMMENT ON COLUMN sap_s4.profit_centers.profit_ctr_responsible_person_name IS 'Person Responsible for Profit Center (SAP ProfitCtrResponsiblePersonName)';
COMMENT ON COLUMN sap_s4.profit_centers.company_code IS 'Company Code (SAP CompanyCode)';
COMMENT ON COLUMN sap_s4.profit_centers.profit_ctr_responsible_user IS 'User Responsible for the Profit Center (SAP ProfitCtrResponsibleUser)';
COMMENT ON COLUMN sap_s4.profit_centers.validity_start_date IS 'Valid-From Date (SAP ValidityStartDate)';
COMMENT ON COLUMN sap_s4.profit_centers.department IS 'Department (SAP Department)';
COMMENT ON COLUMN sap_s4.profit_centers.profit_center_standard_hierarchy IS 'Profit center area (SAP ProfitCenterStandardHierarchy)';
COMMENT ON COLUMN sap_s4.profit_centers.segment IS 'Segment for Segmental Reporting (SAP Segment)';
COMMENT ON COLUMN sap_s4.profit_centers.profit_center_is_blocked IS 'Lock indicator (SAP ProfitCenterIsBlocked)';
COMMENT ON COLUMN sap_s4.profit_centers.formula_planning_template IS 'Template for Formula Planning in Profit Centers (SAP FormulaPlanningTemplate)';
COMMENT ON COLUMN sap_s4.profit_centers.form_of_address IS 'Title (SAP FormOfAddress)';
COMMENT ON COLUMN sap_s4.profit_centers.address_name IS 'Name (SAP AddressName)';
COMMENT ON COLUMN sap_s4.profit_centers.additional_name IS 'Name 2 (SAP AdditionalName)';
COMMENT ON COLUMN sap_s4.profit_centers.profit_center_addr_name3 IS 'Name 3 (SAP ProfitCenterAddrName3)';
COMMENT ON COLUMN sap_s4.profit_centers.profit_center_addr_name4 IS 'Name 4 (SAP ProfitCenterAddrName4)';
COMMENT ON COLUMN sap_s4.profit_centers.street_address_name IS 'Street and House Number (SAP StreetAddressName)';
COMMENT ON COLUMN sap_s4.profit_centers.po_box IS 'PO Box (SAP POBox)';
COMMENT ON COLUMN sap_s4.profit_centers.city_name IS 'City (SAP CityName)';
COMMENT ON COLUMN sap_s4.profit_centers.postal_code IS 'Postal Code (SAP PostalCode)';
COMMENT ON COLUMN sap_s4.profit_centers.po_box_postal_code IS 'PO Box Postal Code (SAP POBoxPostalCode)';
COMMENT ON COLUMN sap_s4.profit_centers.district IS 'District (SAP District)';
COMMENT ON COLUMN sap_s4.profit_centers.country IS 'Country/Region Key (SAP Country)';
COMMENT ON COLUMN sap_s4.profit_centers.region IS 'Region (State, Province, County) (SAP Region)';
COMMENT ON COLUMN sap_s4.profit_centers.tax_jurisdiction IS 'Tax Jurisdiction (SAP TaxJurisdiction)';
COMMENT ON COLUMN sap_s4.profit_centers.language_1 IS 'Language Key (SAP Language_1)';
COMMENT ON COLUMN sap_s4.profit_centers.phone_number1 IS 'First telephone number (SAP PhoneNumber1)';
COMMENT ON COLUMN sap_s4.profit_centers.phone_number2 IS 'Second telephone number (SAP PhoneNumber2)';
COMMENT ON COLUMN sap_s4.profit_centers.telebox_number IS 'Telebox Number (SAP TeleboxNumber)';
COMMENT ON COLUMN sap_s4.profit_centers.telex_number IS 'Telex Number (SAP TelexNumber)';
COMMENT ON COLUMN sap_s4.profit_centers.fax_number IS 'Fax Number (SAP FaxNumber)';
COMMENT ON COLUMN sap_s4.profit_centers.teletex_number IS 'Teletex Number (SAP TeletexNumber)';
COMMENT ON COLUMN sap_s4.profit_centers.data_communication_phone_number IS 'Data communication line no. (SAP DataCommunicationPhoneNumber)';
COMMENT ON COLUMN sap_s4.profit_centers.profit_center_printer_name IS 'Printer name for profit center (SAP ProfitCenterPrinterName)';
COMMENT ON COLUMN sap_s4.profit_centers.profit_center_created_by_user IS 'Entered By (SAP ProfitCenterCreatedByUser)';
COMMENT ON COLUMN sap_s4.profit_centers.profit_center_creation_date IS 'Entered On (SAP ProfitCenterCreationDate)';
COMMENT ON COLUMN sap_s4.profit_centers.logical_system IS 'Logical System (SAP LogicalSystem)';
COMMENT ON COLUMN sap_s4.profit_centers.profit_center_name IS 'Description of Profit Center (SAP ProfitCenterName)';
COMMENT ON COLUMN sap_s4.profit_centers.profit_center_long_name IS 'Description of Profit Center (SAP ProfitCenterLongName)';
COMMENT ON COLUMN sap_s4.profit_centers.language IS 'Language Key (SAP Language)';

CREATE TABLE IF NOT EXISTS sap_s4.journal_entry_items (
  id                                       TEXT NOT NULL,
  source_ledger                            TEXT,
  company_code                             TEXT,
  fiscal_year                              TEXT,
  accounting_document                      TEXT,
  ledger_gl_line_item                      TEXT,
  ledger                                   TEXT,
  ledger_fiscal_year                       TEXT,
  gl_record_type                           TEXT,
  chart_of_accounts                        TEXT,
  controlling_area                         TEXT,
  financial_transaction_type               TEXT,
  business_transaction_category            TEXT,
  controlling_bus_transac_type             TEXT,
  reference_document_type                  TEXT,
  reference_document                       TEXT,
  reference_document_context               TEXT,
  reference_document_item                  TEXT,
  reference_document_item_group            TEXT,
  is_reversal                              BOOLEAN,
  is_reversed                              BOOLEAN,
  source_reference_document                TEXT,
  source_reference_document_item           TEXT,
  source_reference_doc_subitem             TEXT,
  gl_account                               TEXT,
  cost_center                              TEXT,
  profit_center                            TEXT,
  functional_area                          TEXT,
  business_area                            TEXT,
  segment                                  TEXT,
  transaction_currency                     TEXT,
  amount_in_transaction_currency           NUMERIC(24,3),
  company_code_currency                    TEXT,
  amount_in_company_code_currency          NUMERIC(24,3),
  quantity                                 NUMERIC(23,3),
  base_unit                                TEXT,
  valuation_quantity                       NUMERIC(23,3),
  debit_credit_code                        TEXT,
  fiscal_period                            TEXT,
  fiscal_year_variant                      TEXT,
  fiscal_year_period                       TEXT,
  posting_date                             DATE,
  document_date                            DATE,
  accounting_document_type                 TEXT,
  accounting_document_item                 TEXT,
  assignment_reference                     TEXT,
  accounting_document_category             TEXT,
  journal_entry_item_category              TEXT,
  transaction_type_determination           TEXT,
  posting_key                              TEXT,
  creation_date                            DATE,
  gl_account_type                          TEXT,
  alternative_gl_account                   TEXT,
  company                                  TEXT,
  invoice_reference                        TEXT,
  document_item_text                       TEXT,
  product                                  TEXT,
  sales_document                           TEXT,
  sales_document_item                      TEXT,
  supplier                                 TEXT,
  plant                                    TEXT,
  customer                                 TEXT,
  wbs_element_internal_id                  TEXT,
  organization_division                    TEXT,
  distribution_channel                     TEXT,
  clearing_date                            DATE,
  synced_at                                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id)
);
COMMENT ON COLUMN sap_s4.journal_entry_items.id IS 'ID (SAP ID)';
COMMENT ON COLUMN sap_s4.journal_entry_items.source_ledger IS 'Source Ledger (SAP SourceLedger)';
COMMENT ON COLUMN sap_s4.journal_entry_items.company_code IS 'Company Code (SAP CompanyCode)';
COMMENT ON COLUMN sap_s4.journal_entry_items.fiscal_year IS 'Fiscal Year (SAP FiscalYear)';
COMMENT ON COLUMN sap_s4.journal_entry_items.accounting_document IS 'Journal Entry (SAP AccountingDocument)';
COMMENT ON COLUMN sap_s4.journal_entry_items.ledger_gl_line_item IS 'General Ledger Journal Entry Line Item (SAP LedgerGLLineItem)';
COMMENT ON COLUMN sap_s4.journal_entry_items.ledger IS 'Ledger in General Ledger Accounting (SAP Ledger)';
COMMENT ON COLUMN sap_s4.journal_entry_items.ledger_fiscal_year IS 'Fiscal Year of Ledger (SAP LedgerFiscalYear)';
COMMENT ON COLUMN sap_s4.journal_entry_items.gl_record_type IS 'Record Type (SAP GLRecordType)';
COMMENT ON COLUMN sap_s4.journal_entry_items.chart_of_accounts IS 'Chart of Accounts (SAP ChartOfAccounts)';
COMMENT ON COLUMN sap_s4.journal_entry_items.controlling_area IS 'Controlling Area (SAP ControllingArea)';
COMMENT ON COLUMN sap_s4.journal_entry_items.financial_transaction_type IS 'Financial Transaction Type (SAP FinancialTransactionType)';
COMMENT ON COLUMN sap_s4.journal_entry_items.business_transaction_category IS 'Business Transaction Category (SAP BusinessTransactionCategory)';
COMMENT ON COLUMN sap_s4.journal_entry_items.controlling_bus_transac_type IS 'CO Business Transaction (SAP ControllingBusTransacType)';
COMMENT ON COLUMN sap_s4.journal_entry_items.reference_document_type IS 'Reference Document Type (SAP ReferenceDocumentType)';
COMMENT ON COLUMN sap_s4.journal_entry_items.reference_document IS 'Reference Doc. Number (SAP ReferenceDocument)';
COMMENT ON COLUMN sap_s4.journal_entry_items.reference_document_context IS 'Reference Document Context (SAP ReferenceDocumentContext)';
COMMENT ON COLUMN sap_s4.journal_entry_items.reference_document_item IS 'Reference Document Item (SAP ReferenceDocumentItem)';
COMMENT ON COLUMN sap_s4.journal_entry_items.reference_document_item_group IS 'Reference Document Item Group (SAP ReferenceDocumentItemGroup)';
COMMENT ON COLUMN sap_s4.journal_entry_items.is_reversal IS 'Indicator: Item is Reversing Another Item (SAP IsReversal)';
COMMENT ON COLUMN sap_s4.journal_entry_items.is_reversed IS 'Indicator: Item is Reversed (SAP IsReversed)';
COMMENT ON COLUMN sap_s4.journal_entry_items.source_reference_document IS 'Source Reference Document (SAP SourceReferenceDocument)';
COMMENT ON COLUMN sap_s4.journal_entry_items.source_reference_document_item IS 'Source Reference Document Item (SAP SourceReferenceDocumentItem)';
COMMENT ON COLUMN sap_s4.journal_entry_items.source_reference_doc_subitem IS 'Source Reference Document Subitem (SAP SourceReferenceDocSubitem)';
COMMENT ON COLUMN sap_s4.journal_entry_items.gl_account IS 'G/L Account (SAP GLAccount)';
COMMENT ON COLUMN sap_s4.journal_entry_items.cost_center IS 'Cost Center (SAP CostCenter)';
COMMENT ON COLUMN sap_s4.journal_entry_items.profit_center IS 'Profit Center (SAP ProfitCenter)';
COMMENT ON COLUMN sap_s4.journal_entry_items.functional_area IS 'Functional Area (SAP FunctionalArea)';
COMMENT ON COLUMN sap_s4.journal_entry_items.business_area IS 'Business Area (SAP BusinessArea)';
COMMENT ON COLUMN sap_s4.journal_entry_items.segment IS 'Segment for Segmental Reporting (SAP Segment)';
COMMENT ON COLUMN sap_s4.journal_entry_items.transaction_currency IS 'Transaction Currency (SAP TransactionCurrency)';
COMMENT ON COLUMN sap_s4.journal_entry_items.amount_in_transaction_currency IS 'Amount in Transaction Currency (SAP AmountInTransactionCurrency)';
COMMENT ON COLUMN sap_s4.journal_entry_items.company_code_currency IS 'Company Code Currency (SAP CompanyCodeCurrency)';
COMMENT ON COLUMN sap_s4.journal_entry_items.amount_in_company_code_currency IS 'Amount in Company Code Currency (SAP AmountInCompanyCodeCurrency)';
COMMENT ON COLUMN sap_s4.journal_entry_items.quantity IS 'Quantity (SAP Quantity)';
COMMENT ON COLUMN sap_s4.journal_entry_items.base_unit IS 'Base Unit of Measure (SAP BaseUnit)';
COMMENT ON COLUMN sap_s4.journal_entry_items.valuation_quantity IS 'Valuation Quantity (SAP ValuationQuantity)';
COMMENT ON COLUMN sap_s4.journal_entry_items.debit_credit_code IS 'Debit/Credit Code (SAP DebitCreditCode)';
COMMENT ON COLUMN sap_s4.journal_entry_items.fiscal_period IS 'Fiscal Period (SAP FiscalPeriod)';
COMMENT ON COLUMN sap_s4.journal_entry_items.fiscal_year_variant IS 'Fiscal Year Variant (SAP FiscalYearVariant)';
COMMENT ON COLUMN sap_s4.journal_entry_items.fiscal_year_period IS 'Fiscal Year Period (SAP FiscalYearPeriod)';
COMMENT ON COLUMN sap_s4.journal_entry_items.posting_date IS 'Posting Date (SAP PostingDate)';
COMMENT ON COLUMN sap_s4.journal_entry_items.document_date IS 'Journal Entry Date (SAP DocumentDate)';
COMMENT ON COLUMN sap_s4.journal_entry_items.accounting_document_type IS 'Journal Entry Type (SAP AccountingDocumentType)';
COMMENT ON COLUMN sap_s4.journal_entry_items.accounting_document_item IS 'Journal Entry Posting View Item (SAP AccountingDocumentItem)';
COMMENT ON COLUMN sap_s4.journal_entry_items.assignment_reference IS 'Assignment Reference (SAP AssignmentReference)';
COMMENT ON COLUMN sap_s4.journal_entry_items.accounting_document_category IS 'Journal Entry Category (SAP AccountingDocumentCategory)';
COMMENT ON COLUMN sap_s4.journal_entry_items.journal_entry_item_category IS 'Journal Entry Item Category (SAP JournalEntryItemCategory)';
COMMENT ON COLUMN sap_s4.journal_entry_items.transaction_type_determination IS 'Transaction Key (SAP TransactionTypeDetermination)';
COMMENT ON COLUMN sap_s4.journal_entry_items.posting_key IS 'Posting Key (SAP PostingKey)';
COMMENT ON COLUMN sap_s4.journal_entry_items.creation_date IS 'Creation Date (SAP CreationDate)';
COMMENT ON COLUMN sap_s4.journal_entry_items.gl_account_type IS 'Type of a General Ledger Account (SAP GLAccountType)';
COMMENT ON COLUMN sap_s4.journal_entry_items.alternative_gl_account IS 'Alternative G/L Account Number In Company Code (SAP AlternativeGLAccount)';
COMMENT ON COLUMN sap_s4.journal_entry_items.company IS 'Company (SAP Company)';
COMMENT ON COLUMN sap_s4.journal_entry_items.invoice_reference IS 'Invoice Reference (SAP InvoiceReference)';
COMMENT ON COLUMN sap_s4.journal_entry_items.document_item_text IS 'Item Text (SAP DocumentItemText)';
COMMENT ON COLUMN sap_s4.journal_entry_items.product IS 'Product (SAP Product)';
COMMENT ON COLUMN sap_s4.journal_entry_items.sales_document IS 'Sales Document (SAP SalesDocument)';
COMMENT ON COLUMN sap_s4.journal_entry_items.sales_document_item IS 'Sales Document Item (SAP SalesDocumentItem)';
COMMENT ON COLUMN sap_s4.journal_entry_items.supplier IS 'Supplier (SAP Supplier)';
COMMENT ON COLUMN sap_s4.journal_entry_items.plant IS 'Plant (SAP Plant)';
COMMENT ON COLUMN sap_s4.journal_entry_items.customer IS 'Customer Number (SAP Customer)';
COMMENT ON COLUMN sap_s4.journal_entry_items.wbs_element_internal_id IS 'WBS Element Internal ID (SAP WBSElementInternalID)';
COMMENT ON COLUMN sap_s4.journal_entry_items.organization_division IS 'Division (SAP OrganizationDivision)';
COMMENT ON COLUMN sap_s4.journal_entry_items.distribution_channel IS 'Distribution Channel (SAP DistributionChannel)';
COMMENT ON COLUMN sap_s4.journal_entry_items.clearing_date IS 'Clearing Date (SAP ClearingDate)';

CREATE TABLE IF NOT EXISTS sap_s4.billing_document_items (
  billing_document                         TEXT NOT NULL,
  billing_document_item                    TEXT NOT NULL,
  billing_document_item_text               TEXT,
  sales_document_item_category             TEXT,
  sales_document_item_type                 TEXT,
  division                                 TEXT,
  product                                  TEXT,
  batch                                    TEXT,
  product_group                            TEXT,
  plant                                    TEXT,
  billing_quantity_unit                    TEXT,
  billing_quantity_in_base_unit            NUMERIC(13,3),
  item_gross_weight                        NUMERIC(15,3),
  item_net_weight                          NUMERIC(15,3),
  billing_plan_item                        TEXT,
  net_amount                               NUMERIC(16,3),
  gross_amount                             NUMERIC(16,3),
  pricing_date                             DATE,
  transaction_currency                     TEXT,
  tax_amount                               NUMERIC(14,3),
  cost_amount                              NUMERIC(14,3),
  subtotal1_amount                         NUMERIC(14,3),
  subtotal2_amount                         NUMERIC(14,3),
  subtotal3_amount                         NUMERIC(14,3),
  subtotal4_amount                         NUMERIC(14,3),
  subtotal5_amount                         NUMERIC(14,3),
  subtotal6_amount                         NUMERIC(14,3),
  tax_jurisdiction                         TEXT,
  profit_center                            TEXT,
  business_area                            TEXT,
  tax_code                                 TEXT,
  wbs_element_internal_id                  TEXT,
  controlling_area                         TEXT,
  cost_center                              TEXT,
  reference_sd_document_item               TEXT,
  reference_sd_document                    TEXT,
  sales_document                           TEXT,
  sales_document_item                      TEXT,
  service_document                         TEXT,
  service_document_item                    TEXT,
  overall_billing_status                   TEXT,
  sold_to_party                            TEXT,
  payer_party                              TEXT,
  billing_document_date                    DATE,
  company_code                             TEXT,
  county                                   TEXT,
  ship_to_party                            TEXT,
  bill_to_party                            TEXT,
  sales_employee                           TEXT,
  responsible_employee                     TEXT,
  customs_preference                       TEXT,
  item_text                                TEXT,
  line_ref6                                TEXT,
  job_no                                   TEXT,
  line_ref2                                TEXT,
  company_contact                          TEXT,
  line_ref3                                TEXT,
  line_ref_comments                        TEXT,
  line_ref5                                TEXT,
  line_ref1                                TEXT,
  line_ref4                                TEXT,
  field_ticket_no                          TEXT,
  sales_group                              TEXT,
  base_unit                                TEXT,
  item_weight_unit                         TEXT,
  last_change_date                         DATE,
  last_change_date_time                    TIMESTAMPTZ,
  synced_at                                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (billing_document, billing_document_item)
);
COMMENT ON COLUMN sap_s4.billing_document_items.billing_document IS 'Billing Document (SAP BillingDocument)';
COMMENT ON COLUMN sap_s4.billing_document_items.billing_document_item IS 'Billing Item (SAP BillingDocumentItem)';
COMMENT ON COLUMN sap_s4.billing_document_items.billing_document_item_text IS 'Short Text for Sales Order Item (SAP BillingDocumentItemText)';
COMMENT ON COLUMN sap_s4.billing_document_items.sales_document_item_category IS 'Sales Document Item Category (SAP SalesDocumentItemCategory)';
COMMENT ON COLUMN sap_s4.billing_document_items.sales_document_item_type IS 'Item Type (SAP SalesDocumentItemType)';
COMMENT ON COLUMN sap_s4.billing_document_items.division IS 'Division (SAP Division)';
COMMENT ON COLUMN sap_s4.billing_document_items.product IS 'Product (SAP Product)';
COMMENT ON COLUMN sap_s4.billing_document_items.batch IS 'Batch Number (SAP Batch)';
COMMENT ON COLUMN sap_s4.billing_document_items.product_group IS 'Product Group (SAP ProductGroup)';
COMMENT ON COLUMN sap_s4.billing_document_items.plant IS 'Plant (SAP Plant)';
COMMENT ON COLUMN sap_s4.billing_document_items.billing_quantity_unit IS 'Sales Unit (SAP BillingQuantityUnit)';
COMMENT ON COLUMN sap_s4.billing_document_items.billing_quantity_in_base_unit IS 'Billing quantity in stock keeping unit (SAP BillingQuantityInBaseUnit)';
COMMENT ON COLUMN sap_s4.billing_document_items.item_gross_weight IS 'Gross Weight (SAP ItemGrossWeight)';
COMMENT ON COLUMN sap_s4.billing_document_items.item_net_weight IS 'Net Weight (SAP ItemNetWeight)';
COMMENT ON COLUMN sap_s4.billing_document_items.billing_plan_item IS 'Item for billing plan/invoice plan/payment cards (SAP BillingPlanItem)';
COMMENT ON COLUMN sap_s4.billing_document_items.net_amount IS 'Net Value of Billing item in Document Currency (SAP NetAmount)';
COMMENT ON COLUMN sap_s4.billing_document_items.gross_amount IS 'Gross Value of the Billing Item in Document Currency (SAP GrossAmount)';
COMMENT ON COLUMN sap_s4.billing_document_items.pricing_date IS 'Date for Pricing and Exchange Rate (SAP PricingDate)';
COMMENT ON COLUMN sap_s4.billing_document_items.transaction_currency IS 'SD Document Currency (SAP TransactionCurrency)';
COMMENT ON COLUMN sap_s4.billing_document_items.tax_amount IS 'Tax Amount in Document Currency (SAP TaxAmount)';
COMMENT ON COLUMN sap_s4.billing_document_items.cost_amount IS 'Cost in Document Currency (SAP CostAmount)';
COMMENT ON COLUMN sap_s4.billing_document_items.subtotal1_amount IS 'Subtotal 1 from Pricing Procedure for Price Element (SAP Subtotal1Amount)';
COMMENT ON COLUMN sap_s4.billing_document_items.subtotal2_amount IS 'Subtotal 2 from Pricing Procedure for Price Element (SAP Subtotal2Amount)';
COMMENT ON COLUMN sap_s4.billing_document_items.subtotal3_amount IS 'Subtotal 3 from Pricing Procedure for Price Element (SAP Subtotal3Amount)';
COMMENT ON COLUMN sap_s4.billing_document_items.subtotal4_amount IS 'Subtotal 4 from Pricing Procedure for Price Element (SAP Subtotal4Amount)';
COMMENT ON COLUMN sap_s4.billing_document_items.subtotal5_amount IS 'Subtotal 5 from Pricing Procedure for Price Element (SAP Subtotal5Amount)';
COMMENT ON COLUMN sap_s4.billing_document_items.subtotal6_amount IS 'Subtotal 6 from Pricing Procedure for Price Element (SAP Subtotal6Amount)';
COMMENT ON COLUMN sap_s4.billing_document_items.tax_jurisdiction IS 'Tax Jurisdiction (SAP TaxJurisdiction)';
COMMENT ON COLUMN sap_s4.billing_document_items.profit_center IS 'Profit Center (SAP ProfitCenter)';
COMMENT ON COLUMN sap_s4.billing_document_items.business_area IS 'Business Area (SAP BusinessArea)';
COMMENT ON COLUMN sap_s4.billing_document_items.tax_code IS 'Tax on Sales/Purchases Code (SAP TaxCode)';
COMMENT ON COLUMN sap_s4.billing_document_items.wbs_element_internal_id IS 'WBS Element (SAP WBSElementInternalID)';
COMMENT ON COLUMN sap_s4.billing_document_items.controlling_area IS 'Controlling Area (SAP ControllingArea)';
COMMENT ON COLUMN sap_s4.billing_document_items.cost_center IS 'Cost Center (SAP CostCenter)';
COMMENT ON COLUMN sap_s4.billing_document_items.reference_sd_document_item IS 'Item Number of the Reference Item (SAP ReferenceSDDocumentItem)';
COMMENT ON COLUMN sap_s4.billing_document_items.reference_sd_document IS 'Document Number of Reference Document (SAP ReferenceSDDocument)';
COMMENT ON COLUMN sap_s4.billing_document_items.sales_document IS 'Sales Document (SAP SalesDocument)';
COMMENT ON COLUMN sap_s4.billing_document_items.sales_document_item IS 'Sales Document Item (SAP SalesDocumentItem)';
COMMENT ON COLUMN sap_s4.billing_document_items.service_document IS 'Service Document ID (SAP ServiceDocument)';
COMMENT ON COLUMN sap_s4.billing_document_items.service_document_item IS 'Service Document Item ID (SAP ServiceDocumentItem)';
COMMENT ON COLUMN sap_s4.billing_document_items.overall_billing_status IS 'SD Billing Status (SAP OverallBillingStatus)';
COMMENT ON COLUMN sap_s4.billing_document_items.sold_to_party IS 'Sold-to Party (SAP SoldToParty)';
COMMENT ON COLUMN sap_s4.billing_document_items.payer_party IS 'Payer (SAP PayerParty)';
COMMENT ON COLUMN sap_s4.billing_document_items.billing_document_date IS 'Billing Date (SAP BillingDocumentDate)';
COMMENT ON COLUMN sap_s4.billing_document_items.company_code IS 'Company Code (SAP CompanyCode)';
COMMENT ON COLUMN sap_s4.billing_document_items.county IS 'County Code (SAP County)';
COMMENT ON COLUMN sap_s4.billing_document_items.ship_to_party IS 'Ship-to Party (SAP ShipToParty)';
COMMENT ON COLUMN sap_s4.billing_document_items.bill_to_party IS 'Bill-to Party (SAP BillToParty)';
COMMENT ON COLUMN sap_s4.billing_document_items.sales_employee IS 'Sales Employee (SAP SalesEmployee)';
COMMENT ON COLUMN sap_s4.billing_document_items.responsible_employee IS 'Employee Responsible (SAP ResponsibleEmployee)';
COMMENT ON COLUMN sap_s4.billing_document_items.customs_preference IS 'Customs Preference (SAP CustomsPreference)';
COMMENT ON COLUMN sap_s4.billing_document_items.item_text IS 'Item Text (SAP YY1_ItemText_BDI)';
COMMENT ON COLUMN sap_s4.billing_document_items.line_ref6 IS 'LineRef6 (SAP YY1_LineRef6_BDI)';
COMMENT ON COLUMN sap_s4.billing_document_items.job_no IS 'JobNo (SAP YY1_JobNo_BDI)';
COMMENT ON COLUMN sap_s4.billing_document_items.line_ref2 IS 'LineRef2 (SAP YY1_LineRef2_BDI)';
COMMENT ON COLUMN sap_s4.billing_document_items.company_contact IS 'Company Contact (SAP YY1_CompanyContact_BDI)';
COMMENT ON COLUMN sap_s4.billing_document_items.line_ref3 IS 'LineRef3 (SAP YY1_LineRef3_BDI)';
COMMENT ON COLUMN sap_s4.billing_document_items.line_ref_comments IS 'LineRefComments (SAP YY1_LineRefComments_BDI)';
COMMENT ON COLUMN sap_s4.billing_document_items.line_ref5 IS 'LineRef5 (SAP YY1_LineRef5_BDI)';
COMMENT ON COLUMN sap_s4.billing_document_items.line_ref1 IS 'LineRef1 (SAP YY1_LineRef1_BDI)';
COMMENT ON COLUMN sap_s4.billing_document_items.line_ref4 IS 'LineRef4 (SAP YY1_LineRef4_BDI)';
COMMENT ON COLUMN sap_s4.billing_document_items.field_ticket_no IS 'FieldTicketNo (SAP YY1_FieldTicketNo_BDI)';
COMMENT ON COLUMN sap_s4.billing_document_items.sales_group IS 'Sales Group (SAP SalesGroup)';
COMMENT ON COLUMN sap_s4.billing_document_items.base_unit IS 'Base Unit of Measure (SAP BaseUnit)';
COMMENT ON COLUMN sap_s4.billing_document_items.item_weight_unit IS 'Unit of Weight (SAP ItemWeightUnit)';
COMMENT ON COLUMN sap_s4.billing_document_items.last_change_date IS 'Last Changed On (SAP LastChangeDate)';
COMMENT ON COLUMN sap_s4.billing_document_items.last_change_date_time IS 'UTC Time Stamp in Long Form (YYYYMMDDhhmmssmmmuuun) (SAP LastChangeDateTime)';

CREATE INDEX IF NOT EXISTS idx_s4_jei_posting   ON sap_s4.journal_entry_items(ledger, posting_date);
CREATE INDEX IF NOT EXISTS idx_s4_jei_account   ON sap_s4.journal_entry_items(gl_account);
CREATE INDEX IF NOT EXISTS idx_s4_jei_reference ON sap_s4.journal_entry_items(reference_document);
CREATE INDEX IF NOT EXISTS idx_s4_jei_customer  ON sap_s4.journal_entry_items(customer);
CREATE INDEX IF NOT EXISTS idx_s4_jei_supplier  ON sap_s4.journal_entry_items(supplier);
CREATE INDEX IF NOT EXISTS idx_s4_bdi_date      ON sap_s4.billing_document_items(billing_document_date);
CREATE INDEX IF NOT EXISTS idx_s4_bdi_sold_to   ON sap_s4.billing_document_items(sold_to_party);
CREATE INDEX IF NOT EXISTS idx_s4_bdi_ticket    ON sap_s4.billing_document_items(field_ticket_no);

COMMENT ON TABLE sap_s4.customers IS 'S/4HANA customer master (business partner in the customer role), company code 1710.';
COMMENT ON TABLE sap_s4.suppliers IS 'S/4HANA supplier (vendor) master.';
COMMENT ON TABLE sap_s4.ship_to_partners IS 'Ship-to and other partner functions per customer and sales area.';
COMMENT ON TABLE sap_s4.products IS 'S/4HANA product master: service, labor, equipment and material items. fieldvu_related flags items used by FieldVu.';
COMMENT ON TABLE sap_s4.gl_accounts IS 'G/L account master, chart of accounts YCOA. Legacy B1 accounts keep their number without the dash (541200-000 = 541200).';
COMMENT ON TABLE sap_s4.cost_centers IS 'Cost centers (division + location, e.g. 100HOBB Hobbs Electrical). One row per validity period.';
COMMENT ON TABLE sap_s4.profit_centers IS 'Profit centers (location such as HOB, or division + location such as 100HOB). One row per validity period.';
COMMENT ON TABLE sap_s4.journal_entry_items IS 'Universal journal (ACDOCA) lines. Use ledger 0L only; amount_in_company_code_currency is signed (debit positive).';
COMMENT ON TABLE sap_s4.billing_document_items IS 'Customer billing document (invoice / credit memo) items, with FieldVu field ticket and job numbers.';

COMMENT ON COLUMN sap_s4.journal_entry_items.ledger IS 'Ledger: 0L is the leading ledger (the books). 0E repeats every 0L line, so filter ledger = ''0L'' (SAP Ledger)';
COMMENT ON COLUMN sap_s4.journal_entry_items.amount_in_company_code_currency IS 'Signed amount in USD: positive = debit, negative = credit (SAP AmountInCompanyCodeCurrency)';
COMMENT ON COLUMN sap_s4.journal_entry_items.debit_credit_code IS 'S = debit, H = credit as posted; reversals flip it, so use the sign of the amount (SAP DebitCreditCode)';
COMMENT ON COLUMN sap_s4.journal_entry_items.reference_document IS 'Source document number; with reference_document_type VBRK it is billing_document_items.billing_document (SAP ReferenceDocument)';
COMMENT ON COLUMN sap_s4.journal_entry_items.organization_division IS 'Sales division: 10 = 100 Electrical, 20 = 200 Powerline, 40 = 400 Hydrovac, 80 = 800 Automation & Fiber (SAP OrganizationDivision)';
COMMENT ON COLUMN sap_s4.billing_document_items.field_ticket_no IS 'FieldVu field ticket number, zero-padded (SAP YY1_FieldTicketNo_BDI)';
COMMENT ON COLUMN sap_s4.billing_document_items.job_no IS 'FieldVu job number (SAP YY1_JobNo_BDI)';
COMMENT ON COLUMN sap_s4.billing_document_items.sales_document_item_category IS 'Item category: G2W / G2N / SG2N are credit memo items (positive amounts that reduce billing) (SAP SalesDocumentItemCategory)';

-- One general ledger across the cutover. B1 answers posting dates before
-- 2026-08-01 and S/4 answers from it, so a period is never counted twice.
-- S/4 rows only appear once sap_s4.tenant is the production tenant.
CREATE SCHEMA IF NOT EXISTS sap;

CREATE OR REPLACE VIEW sap.gl_lines AS
SELECT
  'SAP B1'::text                                   AS source_system,
  je.reference_date                                AS posting_date,
  EXTRACT(YEAR FROM je.reference_date)::int        AS fiscal_year,
  EXTRACT(MONTH FROM je.reference_date)::int       AS fiscal_period,
  je.jdt_num::text                                 AS document,
  jel.line_id::text                                AS document_line,
  je.origin_type                                   AS document_type,
  CASE WHEN f.fc ~ '^\d{9}$'
       THEN left(f.fc, 6) || CASE WHEN right(f.fc, 3) = '000' THEN '' ELSE '-' || right(f.fc, 3) END
       ELSE f.fc END                               AS gl_account,
  coa.name                                         AS gl_account_name,
  CASE coa.account_type WHEN 'at_Revenues' THEN 'revenue' WHEN 'at_Expenses' THEN 'expense' ELSE 'balance_sheet' END AS account_class,
  (COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0))::numeric(24,3) AS amount,
  jel.costing_code                                 AS division,
  jel.costing_code2                                AS location,
  NULLIF(COALESCE(jel.costing_code, '') || COALESCE(jel.costing_code2, ''), '') AS profit_center,
  NULL::text                                       AS cost_center,
  CASE WHEN jel.short_name IS DISTINCT FROM jel.account_code THEN jel.short_name END AS business_partner,
  COALESCE(jel.project_code, je.project_code)      AS project,
  COALESCE(jel.line_memo, je.memo)                 AS line_text,
  je.origin_type IN ('ttClosingBalance', 'ttOpeningBalance') AS is_period_close
FROM sap_b1.journal_entry_lines jel
JOIN sap_b1.journal_entries je ON je.jdt_num = jel.jdt_num
LEFT JOIN sap_b1.chart_of_accounts coa ON coa.code = jel.account_code
CROSS JOIN LATERAL (SELECT COALESCE(coa.raw_data->>'FormatCode', jel.account_code) AS fc) f
WHERE je.reference_date < DATE '2026-08-01'

UNION ALL

SELECT
  'SAP S/4HANA',
  j.posting_date,
  j.fiscal_year::int,
  j.fiscal_period::int,
  j.accounting_document,
  j.ledger_gl_line_item,
  j.accounting_document_type,
  j.gl_account,
  ga.gl_account_name,
  CASE WHEN ga.is_balance_sheet_account THEN 'balance_sheet'
       WHEN ga.gl_account_type = 'S' OR j.gl_account IN ('999997', '999998') THEN 'allocation'
       WHEN left(j.gl_account, 1) = '4' THEN 'revenue'
       ELSE 'expense' END,
  j.amount_in_company_code_currency,
  d.division,
  d.location,
  NULLIF(COALESCE(d.division, '') || COALESCE(d.location, ''), ''),
  j.cost_center,
  COALESCE(j.customer, j.supplier),
  NULLIF(j.wbs_element_internal_id, '00000000'),
  j.document_item_text,
  FALSE
FROM sap_s4.journal_entry_items j
LEFT JOIN sap_s4.gl_accounts ga ON ga.chart_of_accounts = j.chart_of_accounts AND ga.gl_account = j.gl_account
CROSS JOIN LATERAL (
  SELECT COALESCE(substring(j.cost_center FROM '^(\d{3})'),
                  substring(j.profit_center FROM '^(\d{3})'),
                  CASE WHEN j.organization_division ~ '^\d{2}$' THEN j.organization_division || '0' END) AS division,
         COALESCE(substring(j.profit_center FROM '^\d{3}([A-Z]+)$'), j.profit_center) AS location
) d
WHERE j.ledger = '0L'
  AND j.posting_date >= DATE '2026-08-01'
  AND EXISTS (SELECT 1 FROM sap_s4.tenant t WHERE t.id AND t.environment = 'production');

COMMENT ON VIEW sap.gl_lines IS 'Every general ledger line IPS has: SAP B1 before 2026-08-01, SAP S/4HANA (ledger 0L) from 2026-08-01. amount is signed (debit positive). Exclude is_period_close for period activity and P&L; account_class allocation nets to zero company-wide.';
COMMENT ON COLUMN sap.gl_lines.source_system IS 'SAP B1 or SAP S/4HANA: which system this line came from';
COMMENT ON COLUMN sap.gl_lines.gl_account IS 'Account number as both systems share it: 541200 (B1 541200-000); B1 sub-accounts other than -000 keep the suffix';
COMMENT ON COLUMN sap.gl_lines.account_class IS 'revenue | expense | balance_sheet | allocation (S/4 internal allocations that net to zero company-wide)';
COMMENT ON COLUMN sap.gl_lines.amount IS 'Signed USD: debit positive, credit negative. Revenue = -SUM(amount)';
COMMENT ON COLUMN sap.gl_lines.division IS 'Division code: 100 Electrical, 200 Powerline, 400 Hydrovac, 800 Automation & Fiber, 900 Corporate, overhead 300/600/2xxx';
COMMENT ON COLUMN sap.gl_lines.location IS 'Location code: HOB, MID, AND, LBK, ELP, DAL, LOV (Loving, S/4), CORP';
COMMENT ON COLUMN sap.gl_lines.profit_center IS 'division + location, e.g. 100HOB';
COMMENT ON COLUMN sap.gl_lines.cost_center IS 'S/4 cost center (e.g. 100HOBB); NULL for B1';
COMMENT ON COLUMN sap.gl_lines.business_partner IS 'B1 card code or S/4 customer / supplier number on partner lines';
COMMENT ON COLUMN sap.gl_lines.is_period_close IS 'B1 year-end closing and opening-balance entries: exclude from period activity and P&L, keep for balance-sheet balances';
