public class StructuralTarget {
  void run() {
    System.out.println("alpha");
    System.out.println(42);
    System.out.println(
        "beta");
    System.out.print("not println");
    // System.out.println("comment");
    String text = "System.out.println(\"string\");";
    System.err.println("stderr");
  }
}
