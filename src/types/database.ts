export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export interface Database {
  public: {
    Tables: {
      products: {
        Row: {
          id: number;
          name: string;
          size: string;
          price: number;
          remains: number;
          image_url: string | null;
        };
        Insert: {
          name: string;
          size: string;
          price: number;
          remains: number;
          image_url?: string | null;
        };
        Update: Partial<Database['public']['Tables']['products']['Insert']>;
      };
      cart_items: {
        Row: {
          user_id: string;
          product_id: number;
          quantity: number;
        };
        Insert: {
          user_id: string;
          product_id: number;
          quantity: number;
        };
        Update: Partial<Database['public']['Tables']['cart_items']['Insert']>;
      };
    };
  };
}