using { cuid, managed, Currency } from '@sap/cds/common';

namespace bookshop;

@title: 'Books'
@Core.Description: 'Books in the catalogue, priced in their listed currency'
entity Books : cuid, managed {
  @title: 'Title'
  @mandatory
  title       : String(111);

  @title: 'Description'
  descr       : String(1111);

  @title: 'Author'
  author      : Association to Authors;

  @title: 'Genre'
  genre       : Association to Genres;

  @title: 'Stock'
  @Core.Description: 'Units currently in the warehouse'
  stock       : Integer;

  @title: 'Price'
  price       : Decimal(9, 2);

  currency    : Currency;

  @title: 'Published on'
  publishedAt : Date;

  @title: 'Status'
  status      : Status default 'available';

  reviews     : Composition of many Reviews on reviews.book = $self;
}

type Status : String enum { available; outOfStock = 'out_of_stock'; discontinued; }

@title: 'Authors'
entity Authors : cuid, managed {
  @title: 'Name'
  @mandatory
  name         : String(111);

  @title: 'Date of birth'
  dateOfBirth  : Date;

  @title: 'Date of death'
  dateOfDeath  : Date;

  @title: 'Place of birth'
  placeOfBirth : String;

  @title: 'Email'
  @PersonalData.IsPotentiallySensitive
  email        : String;

  books        : Association to many Books on books.author = $self;
}

@title: 'Genres'
entity Genres : cuid {
  @title: 'Name'
  name     : String(255);
  parent   : Association to Genres;
  children : Composition of many Genres on children.parent = $self;
}

@title: 'Reviews'
entity Reviews : cuid, managed {
  book   : Association to Books;
  @title: 'Rating'
  @assert.range: [1, 5]
  rating : Integer;
  @title: 'Comment'
  text   : String(1111);
  @title: 'Reviewer'
  @PersonalData.IsPotentiallySensitive
  reviewer : String;
}

@title: 'Orders'
@Core.Description: 'Customer orders. Draft-enabled: every record has an active and possibly a draft row.'
entity Orders : cuid, managed {
  @title: 'Order number'
  @readonly
  orderNo     : String(20);

  @title: 'Customer name'
  @mandatory
  customer    : String(111);

  @title: 'Customer email'
  @PersonalData.IsPotentiallySensitive
  customerEmail : String;

  @title: 'Total'
  @readonly
  total       : Decimal(11, 2);
  currency    : Currency;

  @title: 'Placed at'
  placedAt    : DateTime;

  items       : Composition of many OrderItems on items.order = $self;
}

@title: 'Order items'
entity OrderItems : cuid {
  order    : Association to Orders;
  book     : Association to Books;
  @title: 'Quantity'
  quantity : Integer;
  @title: 'Net amount'
  amount   : Decimal(11, 2);
}
