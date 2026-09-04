using { bookshop as my } from '../db/schema';

@path: 'catalog'
service CatalogService {

  @Capabilities.DeleteRestrictions.Deletable: false
  entity Books as projection on my.Books actions {
    @title: 'Restock'
    @Core.Description: 'Increase the stock of this book by the given amount'
    action restock(@title: 'Amount' amount : Integer) returns Books;
  };

  entity Authors as projection on my.Authors;

  @readonly
  entity Genres as projection on my.Genres;

  entity Reviews as projection on my.Reviews;

  @odata.draft.enabled
  entity Orders as projection on my.Orders;

  entity OrderItems as projection on my.OrderItems;

  @title: 'Top books'
  @Core.Description: 'Books with the highest stock, limited to the top N'
  function topBooks(@title: 'How many' n : Integer) returns array of Books;

  @title: 'Submit order'
  @Core.Description: 'Marks an order as placed and stamps placedAt'
  action submitOrder(order : UUID) returns Orders;
}
