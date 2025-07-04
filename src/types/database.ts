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
          price: number;
        };
        Insert: {
          user_id: string;
          product_id: number;
          quantity: number;
          price: number;
        };
        Update: Partial<Database['public']['Tables']['cart_items']['Insert']>;
      };
      telegram_users: {
        Row: {
          id: number;
          telegram_id: number;
          email: string;
          ispring_user_id: string;
          first_name: string | null;
          last_name: string | null;
          expires_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          telegram_id: number;
          email: string;
          ispring_user_id: string;
          first_name?: string | null;
          last_name?: string | null;
          expires_at: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['telegram_users']['Insert']>;
      };
    };
  };
}